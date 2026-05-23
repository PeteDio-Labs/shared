/**
 * Tests for runPlanExecute (kanban 2.8).
 *
 * The LLM is mocked with a script-driven fake — each test queues the
 * expected planner / re-planner / reporter responses and the fake pops
 * them in order. No live Ollama dependency. Tools are simple in-process
 * stubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import {
  runPlanExecute,
  parsePlanResponse,
  type PlanExecuteStep,
} from './planExecute.js';
import type { ChatRequest, ChatResponse, LlmClient } from './llmClient.js';
import type { Tool, ToolExecContext } from './tool.js';

// ─── Fake LlmClient ─────────────────────────────────────────────

interface ScriptedResponse {
  /** Optional matcher — if present, response is only returned when the user message contains this string. */
  match?: string;
  content: string;
}

class FakeLlmClient {
  /** Sequential script of responses; pop from front on each chat() call. */
  script: ScriptedResponse[] = [];
  calls: ChatRequest[] = [];

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const next = this.script.shift();
    if (!next) {
      throw new Error(
        `FakeLlmClient: no scripted response (call #${this.calls.length}). Messages: ${JSON.stringify(
          req.messages.map(m => ({ role: m.role, content: m.content.slice(0, 80) })),
        )}`,
      );
    }
    return {
      message: { role: 'assistant', content: next.content },
      model: req.model ?? 'fake-model',
      done: true,
    };
  }
}

function asLlm(fake: FakeLlmClient): LlmClient {
  return fake as unknown as LlmClient;
}

// ─── Tool helpers ───────────────────────────────────────────────

function echoTool(name: string, behaviour: (args: Record<string, unknown>) => string): Tool {
  return {
    name,
    description: `Echoes input via ${name}`,
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'Value to echo' },
      },
    },
    async execute(args) {
      return behaviour(args ?? {});
    },
  };
}

function makeCtx(): ToolExecContext {
  return {};
}

const log = pino({ level: 'silent' });

// ─── Fixtures ───────────────────────────────────────────────────

const HAPPY_PLAN: PlanExecuteStep[] = [
  { id: 'step-1', title: 'First', toolName: 'alpha', args: { value: 'a' } },
  { id: 'step-2', title: 'Second', toolName: 'beta', args: { value: 'b' } },
  { id: 'step-3', title: 'Third', toolName: 'gamma', args: { value: 'c' } },
];

function planToJson(plan: PlanExecuteStep[]): string {
  return JSON.stringify(plan);
}

// ─── Tests ──────────────────────────────────────────────────────

let fakeLlm: FakeLlmClient;

beforeEach(() => {
  fakeLlm = new FakeLlmClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parsePlanResponse', () => {
  it('parses a valid JSON array', () => {
    const out = parsePlanResponse(planToJson(HAPPY_PLAN));
    expect(out).toHaveLength(3);
    expect(out[0]?.toolName).toBe('alpha');
  });

  it('strips ```json fences', () => {
    const fenced = `\`\`\`json\n${planToJson(HAPPY_PLAN)}\n\`\`\``;
    const out = parsePlanResponse(fenced);
    expect(out).toHaveLength(3);
  });

  it('strips bare ``` fences', () => {
    const fenced = `\`\`\`\n${planToJson(HAPPY_PLAN)}\n\`\`\``;
    const out = parsePlanResponse(fenced);
    expect(out).toHaveLength(3);
  });

  it('throws on empty input', () => {
    expect(() => parsePlanResponse('   ')).toThrow(/empty/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parsePlanResponse('not json at all')).toThrow(/malformed JSON/);
  });

  it('throws on schema mismatch', () => {
    expect(() => parsePlanResponse(JSON.stringify([{ wrong: 'shape' }]))).toThrow(
      /schema validation/,
    );
  });
});

describe('runPlanExecute — happy path', () => {
  it('plans, executes all steps, and returns complete', async () => {
    fakeLlm.script = [
      { content: planToJson(HAPPY_PLAN) },
      { content: 'All three steps completed successfully.' },
    ];

    const tools = new Map<string, Tool>([
      ['alpha', echoTool('alpha', (a) => `ran alpha ${a.value}`)],
      ['beta', echoTool('beta', (a) => `ran beta ${a.value}`)],
      ['gamma', echoTool('gamma', (a) => `ran gamma ${a.value}`)],
    ]);

    const result = await runPlanExecute({
      llm: asLlm(fakeLlm),
      tools,
      userPrompt: 'Do three things',
      toolCtx: makeCtx(),
      log,
    });

    expect(result.status).toBe('complete');
    expect(result.plan).toHaveLength(3);
    expect(result.executed).toHaveLength(3);
    expect(result.replans).toBe(0);
    expect(result.executed[0]?.output).toBe('ran alpha a');
    expect(result.executed[1]?.output).toBe('ran beta b');
    expect(result.executed[2]?.output).toBe('ran gamma c');
    expect(result.finalReport).toMatch(/completed/i);
    // 2 LLM calls — initial plan + final report.
    expect(fakeLlm.calls).toHaveLength(2);
  });

  it('invokes onStepStart for each step', async () => {
    fakeLlm.script = [
      { content: planToJson(HAPPY_PLAN) },
      { content: 'done' },
    ];

    const tools = new Map<string, Tool>([
      ['alpha', echoTool('alpha', () => 'a')],
      ['beta', echoTool('beta', () => 'b')],
      ['gamma', echoTool('gamma', () => 'c')],
    ]);

    const startedSteps: string[] = [];
    await runPlanExecute({
      llm: asLlm(fakeLlm),
      tools,
      userPrompt: 'go',
      toolCtx: makeCtx(),
      log,
      onStepStart: (step) => {
        startedSteps.push(step.id);
      },
    });

    expect(startedSteps).toEqual(['step-1', 'step-2', 'step-3']);
  });
});

describe('runPlanExecute — divergence and re-plan', () => {
  it('re-plans when a step errors and succeeds with new plan', async () => {
    const originalPlan: PlanExecuteStep[] = [
      { id: 'step-1', title: 'First', toolName: 'alpha', args: {} },
      { id: 'step-2', title: 'Second (will fail)', toolName: 'beta', args: {} },
      { id: 'step-3', title: 'Third', toolName: 'gamma', args: {} },
    ];

    const newPlan: PlanExecuteStep[] = [
      { id: 'step-2b', title: 'Recovery', toolName: 'gamma', args: { value: 'recovered' } },
    ];

    fakeLlm.script = [
      { content: planToJson(originalPlan) },
      { content: planToJson(newPlan) },
      { content: 'Recovered and finished.' },
    ];

    const tools = new Map<string, Tool>([
      ['alpha', echoTool('alpha', () => 'a-ok')],
      ['beta', echoTool('beta', () => 'Error: beta broke')],
      ['gamma', echoTool('gamma', (a) => `gamma ran ${a.value ?? ''}`)],
    ]);

    let replanCalls = 0;
    const result = await runPlanExecute({
      llm: asLlm(fakeLlm),
      tools,
      userPrompt: 'do work with recovery',
      toolCtx: makeCtx(),
      log,
      onReplan: () => {
        replanCalls++;
      },
    });

    expect(result.status).toBe('complete');
    expect(result.replans).toBe(1);
    expect(replanCalls).toBe(1);
    // Executed: alpha (ok), beta (error -> trigger), gamma (recovery)
    expect(result.executed).toHaveLength(3);
    expect(result.executed[0]?.output).toBe('a-ok');
    expect(result.executed[1]?.output).toMatch(/Error/);
    expect(result.executed[2]?.output).toBe('gamma ran recovered');
    // Canonical plan includes appended new steps.
    expect(result.plan).toHaveLength(originalPlan.length + newPlan.length);
  });

  it('treats "DIVERGENCE:" prefixed output as a re-plan trigger', async () => {
    const originalPlan: PlanExecuteStep[] = [
      { id: 'step-1', title: 'Probe', toolName: 'probe', args: {} },
    ];
    const newPlan: PlanExecuteStep[] = [
      { id: 'step-2', title: 'Recover', toolName: 'fix', args: {} },
    ];

    fakeLlm.script = [
      { content: planToJson(originalPlan) },
      { content: planToJson(newPlan) },
      { content: 'Detected drift and recovered.' },
    ];

    const tools = new Map<string, Tool>([
      ['probe', echoTool('probe', () => 'DIVERGENCE: state drift detected')],
      ['fix', echoTool('fix', () => 'fixed')],
    ]);

    const result = await runPlanExecute({
      llm: asLlm(fakeLlm),
      tools,
      userPrompt: 'probe then maybe fix',
      toolCtx: makeCtx(),
      log,
    });

    expect(result.status).toBe('complete');
    expect(result.replans).toBe(1);
    expect(result.executed.at(-1)?.output).toBe('fixed');
  });
});

describe('runPlanExecute — failure modes', () => {
  it('returns failed when max re-plans exceeded', async () => {
    const failingPlan: PlanExecuteStep[] = [
      { id: 'step-1', title: 'Fail', toolName: 'broken', args: {} },
    ];

    fakeLlm.script = [
      { content: planToJson(failingPlan) }, // initial plan
      { content: planToJson(failingPlan) }, // re-plan 1
      { content: planToJson(failingPlan) }, // re-plan 2 (still failing)
      { content: 'All attempts failed.' },  // reporter
    ];

    const tools = new Map<string, Tool>([
      ['broken', echoTool('broken', () => 'Error: always broken')],
    ]);

    const result = await runPlanExecute({
      llm: asLlm(fakeLlm),
      tools,
      userPrompt: 'do impossible thing',
      toolCtx: makeCtx(),
      log,
      maxReplans: 2,
    });

    expect(result.status).toBe('failed');
    expect(result.replans).toBe(2);
    // 3 attempts at broken tool + 0 successful = 3 executed
    expect(result.executed).toHaveLength(3);
    expect(result.finalReport).toBeTruthy();
  });

  it('returns failed when initial planner returns malformed JSON', async () => {
    fakeLlm.script = [
      { content: 'this is not JSON at all, sorry' },
      { content: 'Could not plan.' }, // reporter
    ];

    const result = await runPlanExecute({
      llm: asLlm(fakeLlm),
      tools: new Map(),
      userPrompt: 'task',
      toolCtx: makeCtx(),
      log,
    });

    expect(result.status).toBe('failed');
    expect(result.plan).toEqual([]);
    expect(result.executed).toEqual([]);
    expect(result.finalReport).toBeTruthy();
  });

  it('triggers re-plan when planner produces unknown tool name', async () => {
    const badPlan: PlanExecuteStep[] = [
      { id: 'step-1', title: 'Use ghost', toolName: 'ghost', args: {} },
    ];
    const goodPlan: PlanExecuteStep[] = [
      { id: 'step-2', title: 'Use real', toolName: 'real', args: {} },
    ];

    fakeLlm.script = [
      { content: planToJson(badPlan) },
      { content: planToJson(goodPlan) },
      { content: 'Recovered from missing tool.' },
    ];

    const tools = new Map<string, Tool>([
      ['real', echoTool('real', () => 'real ran')],
    ]);

    const result = await runPlanExecute({
      llm: asLlm(fakeLlm),
      tools,
      userPrompt: 'pick the right tool',
      toolCtx: makeCtx(),
      log,
    });

    expect(result.status).toBe('complete');
    expect(result.replans).toBe(1);
    // First executed entry records the unknown-tool error.
    expect(result.executed[0]?.output).toMatch(/unknown tool/);
    // Last executed entry is the recovery step.
    expect(result.executed.at(-1)?.output).toBe('real ran');
  });

  it('caller-supplied abort signal returns cancelled before execution', async () => {
    fakeLlm.script = [
      { content: planToJson(HAPPY_PLAN) },
      { content: 'cancelled' },
    ];

    const tools = new Map<string, Tool>([
      ['alpha', echoTool('alpha', () => 'should not run')],
      ['beta', echoTool('beta', () => 'should not run')],
      ['gamma', echoTool('gamma', () => 'should not run')],
    ]);

    const ctrl = new AbortController();
    ctrl.abort();

    const result = await runPlanExecute({
      llm: asLlm(fakeLlm),
      tools,
      userPrompt: 'will be aborted',
      toolCtx: makeCtx(),
      log,
      signal: ctrl.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(result.executed).toEqual([]);
  });

  it('tool that throws is captured as an error string and triggers re-plan', async () => {
    const originalPlan: PlanExecuteStep[] = [
      { id: 'step-1', title: 'Throws', toolName: 'thrower', args: {} },
    ];
    const newPlan: PlanExecuteStep[] = [
      { id: 'step-2', title: 'Safe', toolName: 'safe', args: {} },
    ];

    fakeLlm.script = [
      { content: planToJson(originalPlan) },
      { content: planToJson(newPlan) },
      { content: 'Recovered from thrown error.' },
    ];

    const tools = new Map<string, Tool>([
      [
        'thrower',
        {
          name: 'thrower',
          description: 'throws',
          parameters: { type: 'object', properties: {} },
          async execute() {
            throw new Error('boom');
          },
        },
      ],
      ['safe', echoTool('safe', () => 'safe ran')],
    ]);

    const result = await runPlanExecute({
      llm: asLlm(fakeLlm),
      tools,
      userPrompt: 'maybe throws',
      toolCtx: makeCtx(),
      log,
    });

    expect(result.status).toBe('complete');
    expect(result.executed[0]?.output).toMatch(/Error executing thrower: boom/);
    expect(result.executed.at(-1)?.output).toBe('safe ran');
  });
});
