/**
 * planExecute — the third harness mode (kanban 2.8).
 *
 * Plan / execute / re-plan loop. A planner LLM call generates the full
 * step list upfront, the executor walks it, and a re-planner adjusts on
 * divergence (capped at `maxReplans`, default 2). The flow is:
 *
 *   1. PLAN     — one LLM call produces JSON array of steps. Each step
 *                 has id, title, toolName, args, optional rationale.
 *   2. EXECUTE  — for each step, look up tool by name and call
 *                 tool.execute(step.args, toolCtx). Record output +
 *                 duration. Treat "Error ..." or "DIVERGENCE: ..." as
 *                 a divergence trigger.
 *   3. RE-PLAN  — on divergence (or unknown tool name), call the LLM
 *                 again with the original task + executed-so-far +
 *                 divergence reason. Replace the remaining plan with
 *                 the new one. Bounded by maxReplans.
 *   4. REPORT   — one final LLM call summarises the run; the text is
 *                 returned as `finalReport`. On hard failure, the
 *                 reason is embedded in the report.
 *
 * Natural fit for infra-agent (Terraform plan → review → apply) and any
 * long-horizon ops where re-deliberating each step burns tokens without
 * quality gain. Contrast with `runToolLoop` (ReAct, re-deliberates every
 * step) and `runDeterministicPlan` (no LLM in the hot loop at all).
 */

import type pino from 'pino';
import { z } from 'zod';

import type { LlmClient, ChatMessage } from './llmClient.js';
import type { Tool, ToolExecContext } from './tool.js';

// ─── Public types ───────────────────────────────────────────────

export interface PlanExecuteStep {
  id: string;
  title: string;
  toolName: string;
  args: Record<string, unknown>;
  rationale?: string;
}

export interface ExecutedStep {
  step: PlanExecuteStep;
  output: string;
  durationMs: number;
}

export interface PlanExecuteResult {
  status: 'complete' | 'failed' | 'cancelled';
  plan: PlanExecuteStep[];
  executed: ExecutedStep[];
  replans: number;
  finalReport: string;
}

export interface PlanExecuteOptions {
  llm: LlmClient;
  model?: string;
  tools: Map<string, Tool>;
  /** Task-specific system prompt (prepended to the planner system prompt). */
  system?: string;
  /** The task description to plan against. */
  userPrompt: string;
  toolCtx: ToolExecContext;
  log: pino.Logger;
  /** Maximum number of re-plan attempts. Default 2. */
  maxReplans?: number;
  onStepStart?: (step: PlanExecuteStep, index: number) => void | Promise<void>;
  onReplan?: (reason: string, newPlan: PlanExecuteStep[]) => void | Promise<void>;
  signal?: AbortSignal;
}

// ─── Validation schemas ─────────────────────────────────────────

const StepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  rationale: z.string().optional(),
});

export const PlanSchema = z.array(StepSchema);

// ─── Prompts ────────────────────────────────────────────────────

const PLANNER_SYSTEM = [
  'You are a planner. Given a task and a list of available tools, produce a JSON array of steps that will accomplish the task.',
  'Each step MUST have:',
  '  - id: short string like "step-1", "step-2"',
  '  - title: human-readable one-liner',
  '  - toolName: must match one of the available tool names exactly',
  '  - args: object whose keys match the tool\'s parameters schema',
  '  - rationale: optional, why this step',
  'Output ONLY the JSON array. No prose. No markdown fences. No commentary.',
].join('\n');

const REPLANNER_SYSTEM = [
  'You are a re-planner. The original plan diverged or failed at a step.',
  'Given the original task, what was already executed, and the divergence reason, produce a NEW JSON array of steps covering only the REMAINING work.',
  'Use the same step schema as the original plan.',
  'Output ONLY the JSON array. No prose. No markdown fences. No commentary.',
].join('\n');

const REPORTER_SYSTEM = [
  'You are summarising the outcome of a plan-and-execute agent run.',
  'Given the original task, the executed steps, and any failure reason, write a concise 1-2 paragraph plain-text summary of what was done and the result. No markdown headings.',
].join('\n');

// ─── Public entry point ─────────────────────────────────────────

export async function runPlanExecute(opts: PlanExecuteOptions): Promise<PlanExecuteResult> {
  const maxReplans = opts.maxReplans ?? 2;
  const executed: ExecutedStep[] = [];
  let replans = 0;
  let plan: PlanExecuteStep[] = [];

  // ─── Step 1: initial plan ─────────────────────────────────────
  try {
    plan = await callPlanner(opts);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.log.error({ err: reason }, 'plan-execute: initial planning failed');
    const report = await safeReport(opts, executed, `Initial planning failed: ${reason}`);
    return {
      status: 'failed',
      plan: [],
      executed: [],
      replans: 0,
      finalReport: report,
    };
  }

  if (opts.signal?.aborted) {
    return cancelled(plan, executed, replans, 'cancelled before execution');
  }

  // ─── Step 2: execute / re-plan loop ───────────────────────────
  // We maintain a queue of steps to run. On divergence we re-plan and
  // replace the queue with the new step list.
  let remaining = [...plan];

  while (remaining.length > 0) {
    if (opts.signal?.aborted) {
      return cancelled(plan, executed, replans, 'cancelled mid-execution');
    }

    const step = remaining.shift()!;
    const index = executed.length;
    const tool = opts.tools.get(step.toolName);

    let divergenceReason: string | null = null;

    if (!tool) {
      divergenceReason = `Unknown tool "${step.toolName}" — not registered in this agent.`;
      // Record the failed step so the re-planner has context.
      executed.push({
        step,
        output: `Error: unknown tool "${step.toolName}"`,
        durationMs: 0,
      });
    } else {
      try {
        await opts.onStepStart?.(step, index);
      } catch (cbErr) {
        opts.log.warn(
          { err: cbErr instanceof Error ? cbErr.message : String(cbErr) },
          'plan-execute: onStepStart callback threw — continuing',
        );
      }

      const startMs = Date.now();
      let output: string;
      try {
        output = await tool.execute(step.args as never, opts.toolCtx);
      } catch (err) {
        output = `Error executing ${step.toolName}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      const durationMs = Date.now() - startMs;

      executed.push({ step, output, durationMs });

      if (isDivergence(output)) {
        divergenceReason = `Step ${step.id} (${step.toolName}) diverged: ${output.slice(0, 500)}`;
      }
    }

    if (divergenceReason) {
      if (replans >= maxReplans) {
        const reason = `Max re-plans (${maxReplans}) exceeded. Last divergence: ${divergenceReason}`;
        opts.log.warn({ replans, divergenceReason }, 'plan-execute: max re-plans exceeded');
        const report = await safeReport(opts, executed, reason);
        return {
          status: 'failed',
          plan,
          executed,
          replans,
          finalReport: report,
        };
      }

      replans++;
      opts.log.info(
        { replans, divergenceReason },
        'plan-execute: divergence detected — re-planning',
      );

      let newPlan: PlanExecuteStep[];
      try {
        newPlan = await callReplanner(opts, executed, divergenceReason);
      } catch (err) {
        const reason = `Re-plan failed: ${err instanceof Error ? err.message : String(err)}`;
        opts.log.error({ err: reason }, 'plan-execute: re-planner errored');
        const report = await safeReport(opts, executed, reason);
        return {
          status: 'failed',
          plan,
          executed,
          replans,
          finalReport: report,
        };
      }

      try {
        await opts.onReplan?.(divergenceReason, newPlan);
      } catch (cbErr) {
        opts.log.warn(
          { err: cbErr instanceof Error ? cbErr.message : String(cbErr) },
          'plan-execute: onReplan callback threw — continuing',
        );
      }

      // Append the new plan onto the canonical plan so callers can see the
      // full trajectory, and reset the remaining queue.
      plan = [...plan, ...newPlan];
      remaining = [...newPlan];
    }
  }

  // ─── Step 3: final report ─────────────────────────────────────
  const finalReport = await safeReport(opts, executed, null);
  return {
    status: 'complete',
    plan,
    executed,
    replans,
    finalReport,
  };
}

// ─── Internals ──────────────────────────────────────────────────

function cancelled(
  plan: PlanExecuteStep[],
  executed: ExecutedStep[],
  replans: number,
  reason: string,
): PlanExecuteResult {
  return {
    status: 'cancelled',
    plan,
    executed,
    replans,
    finalReport: reason,
  };
}

function isDivergence(output: string): boolean {
  if (typeof output !== 'string') return false;
  return output.startsWith('Error') || output.startsWith('DIVERGENCE:');
}

function buildToolCatalog(tools: Map<string, Tool>): string {
  if (tools.size === 0) return '(no tools available)';
  const lines: string[] = [];
  for (const tool of tools.values()) {
    lines.push(`- name: ${tool.name}`);
    lines.push(`  description: ${tool.description}`);
    lines.push(`  parameters: ${JSON.stringify(tool.parameters)}`);
  }
  return lines.join('\n');
}

async function callPlanner(opts: PlanExecuteOptions): Promise<PlanExecuteStep[]> {
  const catalog = buildToolCatalog(opts.tools);
  const systemParts = [PLANNER_SYSTEM];
  if (opts.system && opts.system.trim().length > 0) {
    systemParts.unshift(opts.system.trim());
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: systemParts.join('\n\n') },
    {
      role: 'user',
      content: [
        `TASK:\n${opts.userPrompt}`,
        '',
        `AVAILABLE TOOLS:\n${catalog}`,
        '',
        'Produce the JSON plan now.',
      ].join('\n'),
    },
  ];

  const res = await opts.llm.chat({
    ...(opts.model ? { model: opts.model } : {}),
    messages,
    temperature: 0,
  });

  return parsePlanResponse(res.message?.content ?? '');
}

async function callReplanner(
  opts: PlanExecuteOptions,
  executed: ExecutedStep[],
  divergenceReason: string,
): Promise<PlanExecuteStep[]> {
  const catalog = buildToolCatalog(opts.tools);
  const systemParts = [REPLANNER_SYSTEM];
  if (opts.system && opts.system.trim().length > 0) {
    systemParts.unshift(opts.system.trim());
  }
  const executedSummary = executed.length === 0
    ? '(none yet)'
    : executed
        .map(
          (e, i) =>
            `${i + 1}. [${e.step.toolName}] ${e.step.title}\n   output: ${e.output.slice(0, 400)}`,
        )
        .join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: systemParts.join('\n\n') },
    {
      role: 'user',
      content: [
        `ORIGINAL TASK:\n${opts.userPrompt}`,
        '',
        `ALREADY EXECUTED:\n${executedSummary}`,
        '',
        `DIVERGENCE REASON:\n${divergenceReason}`,
        '',
        `AVAILABLE TOOLS:\n${catalog}`,
        '',
        'Produce the NEW JSON plan covering only the REMAINING work.',
      ].join('\n'),
    },
  ];

  const res = await opts.llm.chat({
    ...(opts.model ? { model: opts.model } : {}),
    messages,
    temperature: 0,
  });

  return parsePlanResponse(res.message?.content ?? '');
}

/**
 * Parse and validate a planner LLM response. Strips common markdown fences
 * the model emits despite the instruction, then runs the JSON through
 * `PlanSchema`. Throws with a descriptive message on any failure so the
 * caller can surface it in the final report.
 */
export function parsePlanResponse(raw: string): PlanExecuteStep[] {
  const trimmed = stripFences(raw).trim();
  if (!trimmed) {
    throw new Error('planner returned empty response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`planner returned malformed JSON: ${msg}. Raw: ${trimmed.slice(0, 200)}`);
  }

  const result = PlanSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`planner JSON failed schema validation: ${result.error.message}`);
  }

  return result.data as PlanExecuteStep[];
}

function stripFences(s: string): string {
  // Common LLM patterns: ```json\n...\n``` or ```\n...\n```
  const match = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (match && match[1]) return match[1];
  return s;
}

async function callReporter(
  opts: PlanExecuteOptions,
  executed: ExecutedStep[],
  failureReason: string | null,
): Promise<string> {
  const summaryLines = executed.length === 0
    ? '(no steps executed)'
    : executed
        .map(
          (e, i) =>
            `${i + 1}. [${e.step.toolName}] ${e.step.title} (${e.durationMs}ms)\n   ${e.output.slice(0, 400)}`,
        )
        .join('\n');

  const userParts = [
    `ORIGINAL TASK:\n${opts.userPrompt}`,
    '',
    `EXECUTED STEPS:\n${summaryLines}`,
  ];
  if (failureReason) {
    userParts.push('', `FAILURE REASON:\n${failureReason}`);
  }
  userParts.push('', 'Write the 1-2 paragraph plain-text summary now.');

  const messages: ChatMessage[] = [
    { role: 'system', content: REPORTER_SYSTEM },
    { role: 'user', content: userParts.join('\n') },
  ];

  const res = await opts.llm.chat({
    ...(opts.model ? { model: opts.model } : {}),
    messages,
    temperature: 0.2,
  });

  return (res.message?.content ?? '').trim();
}

/**
 * Wrap callReporter so a failing report LLM call doesn't mask the
 * actual run outcome. If the LLM is down at report time we still want
 * to return a usable report string that captures what happened.
 */
async function safeReport(
  opts: PlanExecuteOptions,
  executed: ExecutedStep[],
  failureReason: string | null,
): Promise<string> {
  try {
    const text = await callReporter(opts, executed, failureReason);
    if (text) return text;
    return fallbackReport(executed, failureReason);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.log.warn({ err: msg }, 'plan-execute: reporter LLM call failed — using fallback');
    return fallbackReport(executed, failureReason);
  }
}

function fallbackReport(executed: ExecutedStep[], failureReason: string | null): string {
  const parts: string[] = [];
  parts.push(
    `plan-execute summary: ${executed.length} step(s) executed.`,
  );
  if (failureReason) parts.push(`Failure: ${failureReason}`);
  return parts.join(' ');
}
