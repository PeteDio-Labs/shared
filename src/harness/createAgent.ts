/**
 * createAgent — the harness factory. Composes the existing primitives
 * (loop.ts, deterministic.ts, reporter.ts, metrics.ts) into a single
 * declarative agent definition.
 *
 * Phase 3 pilot uses this with one agent per process. Phase 5 swaps to
 * the multiplexed harness process (services/harness/) that registers
 * many agents in one Bun process — same factory, different host.
 */

import pino, { type Logger } from 'pino';
import type { z } from 'zod';

import { AgentReporter } from '../agents/reporter.js';
import { runDeterministicPlan } from '../agents/deterministic.js';
import { runToolLoop } from '../agents/loop.js';
import {
  initAgentMetrics,
  recordAgentRunDuration,
  type AgentRunStatus,
} from '../agents/metrics.js';
import type { AgentResult, TaskPayload } from '../agents/types.js';

import { LlmClient } from './llmClient.js';
import { noopMemory, type Memory } from './memory.js';
import { runPlanExecute } from './planExecute.js';
import { wrapToolExecution, type Tool } from './tool.js';
import { startStandaloneAgentServer, type ServerHandle } from './server.js';

export type AgentMode = 'deterministic' | 'tool-loop' | 'plan-execute';

export interface AgentRunContext<TInput> {
  payload: TaskPayload;
  input: TInput;
  reporter: AgentReporter;
  llm: LlmClient;
  memory: Memory;
  tools: Map<string, Tool>;
  log: Logger;
  runDeterministic: typeof runDeterministicPlan;
  runToolLoop: typeof runToolLoop;
  runPlanExecute: typeof runPlanExecute;
}

export interface CreateAgentOptions<TInput> {
  name: string;
  model: string;
  port: number;
  mode: AgentMode;
  system?: string;
  tools?: Tool[];
  memory?: Memory;
  taskSchema: z.ZodType<TInput>;
  mcUrl?: string;
  llm?: ConstructorParameters<typeof LlmClient>[0];
  run: (ctx: AgentRunContext<TInput>) => Promise<AgentResult>;
}

export interface AgentHandle {
  name: string;
  start(): Promise<ServerHandle>;
}

export function createAgent<TInput>(opts: CreateAgentOptions<TInput>): AgentHandle {
  const log = pino({ level: process.env.LOG_LEVEL ?? 'info', name: opts.name });
  const memory = opts.memory ?? noopMemory();
  const llm = new LlmClient({ defaultModel: opts.model, ...(opts.llm ?? {}) });
  // Wrap each tool so invocations auto-record agent_tool_calls_total +
  // agent_tool_duration_seconds. The wrapper preserves name/description/
  // parameters/gate/dryRun and is transparent to consumers.
  const wrappedTools = (opts.tools ?? []).map(t => wrapToolExecution(t));
  const tools = new Map<string, Tool>(wrappedTools.map(t => [t.name, t]));
  const mcUrl = opts.mcUrl ?? process.env.MC_BACKEND_URL ?? 'http://localhost:3000';

  // Initialise metrics eagerly so /metrics scrapes BEFORE the first /run
  // return `agent_up{agent}=1` instead of throwing from getMetricsRegistry().
  // initAgentMetrics is idempotent — AgentReporter's repeat call inside
  // handleRun is a no-op.
  initAgentMetrics({ agentName: opts.name });

  async function handleRun(rawBody: unknown): Promise<{ status: number; body: unknown }> {
    const payload = rawBody as TaskPayload;
    if (!payload || typeof payload.taskId !== 'string') {
      return { status: 400, body: { error: 'invalid TaskPayload' } };
    }

    const inputParse = opts.taskSchema.safeParse(payload.input);
    if (!inputParse.success) {
      return { status: 400, body: { error: 'invalid input', details: inputParse.error.flatten() } };
    }

    const reporter = new AgentReporter({
      mcUrl,
      taskId: payload.taskId,
      agentName: opts.name,
    });

    // Ack immediately so MC doesn't think the request hung; run in background.
    void (async () => {
      const start = performance.now();
      let runStatus: AgentRunStatus = 'complete';
      try {
        await reporter.running(`starting ${opts.name}`);
        const result = await opts.run({
          payload,
          input: inputParse.data,
          reporter,
          llm,
          memory,
          tools,
          log,
          runDeterministic: runDeterministicPlan,
          runToolLoop,
          runPlanExecute,
        });
        runStatus = result.status;
        await reporter.complete(result);
      } catch (err) {
        runStatus = 'failed';
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ taskId: payload.taskId, err: msg }, 'agent run failed');
        await reporter.fail(msg);
      } finally {
        const seconds = (performance.now() - start) / 1000;
        recordAgentRunDuration(seconds, runStatus);
      }
    })();

    return { status: 202, body: { accepted: true, taskId: payload.taskId } };
  }

  return {
    name: opts.name,
    start: () =>
      startStandaloneAgentServer({
        port: opts.port,
        agentName: opts.name,
        log,
        onRun: handleRun,
        onHealth: () => ({
          mode: opts.mode,
          model: opts.model,
          tools: Array.from(tools.keys()),
        }),
      }),
  };
}
