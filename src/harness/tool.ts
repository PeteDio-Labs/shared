/**
 * Tool interface for the harness — extends the existing ToolDef from
 * ../agents/loop.ts with approval gating (gate) and dry-run support.
 *
 * The agentic loop calls `execute(args, ctx)`. If `gate(args)` returns
 * a GatedAction, the harness routes through reporter.requestApproval
 * before executing. If `dryRun` is defined, the harness can preview
 * the side effects without committing.
 */

import type { GatedAction } from '../agents/types.js';
import type { AgentReporter } from '../agents/reporter.js';
import type { ToolDef } from '../agents/loop.js';
import type pino from 'pino';

export interface ToolExecContext {
  /**
   * The active agent's reporter, so tools can stream log lines or request
   * approval mid-execution. Optional so callers can pass `{}` for unit
   * tests / one-off invocations that don't need MC integration.
   */
  reporter?: AgentReporter;
  /** Pino child logger scoped to the agent. Optional for the same reason. */
  log?: pino.Logger;
  /**
   * Cancellation signal. Optional — the harness does not currently thread
   * a per-step signal through `runDeterministicPlan`'s executeStep callback,
   * so consumers either supply their own (`AbortSignal.timeout(...)`) or
   * default inside the tool body. A future minor version may derive this
   * from a per-task AbortController; until then `args.signal ?? AbortSignal.timeout(default)`
   * is the canonical pattern for tools that need one.
   */
  signal?: AbortSignal;
}

export interface Tool<TArgs = Record<string, unknown>> extends Omit<ToolDef<TArgs>, 'execute'> {
  /** Execute the tool. The harness wraps this in metrics + error handling. */
  execute(args: TArgs, ctx: ToolExecContext): Promise<string>;

  /**
   * Optional approval gate. If returns a GatedAction, the harness blocks
   * on reporter.requestApproval before calling execute. Mirrors the
   * existing infra-agent dry-run/approve pattern.
   */
  gate?(args: TArgs): GatedAction | null;

  /** Optional preview — same shape as execute but must not mutate state. */
  dryRun?(args: TArgs, ctx: ToolExecContext): Promise<string>;
}
