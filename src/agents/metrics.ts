/**
 * Shared Prometheus metrics for the agent fleet.
 *
 * Each agent process owns a single metrics Registry. Agents are expected
 * to mount the registry on their own HTTP server at `/metrics` — this
 * module does NOT start a server, it only exposes the registry and
 * metric handles.
 *
 * Metrics:
 *   - `agent_up{agent}`                                   — Gauge, 1 on startup, 0 on shutdown
 *   - `agent_runs_total{agent,status}`                    — Counter, increments on terminal status
 *   - `agent_run_duration_seconds{agent,status}`          — Histogram, wall-clock per run
 *   - `agent_tool_calls_total{agent,tool,status}`         — Counter, per tool invocation
 *   - `agent_tool_duration_seconds{agent,tool}`           — Histogram, per tool execution
 *   - `agent_llm_calls_total{agent,model,status}`         — Counter, per LLM chat() call
 *   - `agent_approval_requests_total{agent,outcome}`      — Counter, per approval cycle
 *   - `agent_memory_ops_total{agent,op}`                  — Counter, per memory recall/remember/forget
 *   - `agent_metrics_uninitialized_total{metric}`         — Counter, visibility into helpers
 *     called before `initAgentMetrics()`. Always registered.
 *
 * The agent name is supplied via `initAgentMetrics({ agentName })` (called
 * automatically by `AgentReporter` + the `createAgent` harness factory).
 */
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

// ─── Run status label values ─────────────────────────────────────
//
// Mirrors the `runDeterministicPlan` step status union *plus* `cancelled`
// to leave room for future explicit user/operator cancellation. Today the
// reporter increments only `complete` / `failed`; `skipped` and `cancelled`
// are reserved so the dashboard query stays stable across versions.
//
// If you add a new value, also update the Grafana dashboard panel queries.
export type AgentRunStatus = 'complete' | 'failed' | 'cancelled' | 'skipped';

const ALL_STATUSES: readonly AgentRunStatus[] = [
  'complete',
  'failed',
  'cancelled',
  'skipped',
];

// ─── Histogram buckets ───────────────────────────────────────────
//
// `agent_run_duration_seconds` covers whole agent runs which lean long
// (LLM-heavy). 0.1 s → 5 min keeps the histogram useful for both quick
// deterministic plans and slow tool-loop sessions.
const RUN_DURATION_BUCKETS = [0.1, 0.5, 1, 2, 5, 15, 30, 60, 120, 300] as const;

// `agent_tool_duration_seconds` covers both fast deterministic ops
// (under 100 ms) and slow LLM-backed tools (tens of seconds), so the
// bucket range starts tighter at the low end.
const TOOL_DURATION_BUCKETS = [0.01, 0.1, 0.5, 1, 2, 5, 15, 30, 60] as const;

// ─── Module-level state ──────────────────────────────────────────

let _registry: Registry | null = null;
let _agentUp: Gauge<'agent'> | null = null;
let _agentRunsTotal: Counter<'agent' | 'status'> | null = null;
let _agentRunDuration: Histogram<'agent' | 'status'> | null = null;
let _agentToolCallsTotal: Counter<'agent' | 'tool' | 'status'> | null = null;
let _agentToolDuration: Histogram<'agent' | 'tool'> | null = null;
let _agentLlmCallsTotal: Counter<'agent' | 'model' | 'status'> | null = null;
let _agentApprovalRequestsTotal: Counter<'agent' | 'outcome'> | null = null;
let _agentMemoryOpsTotal: Counter<'agent' | 'op'> | null = null;
let _agentMetricsUninitialized: Counter<'metric'> | null = null;
let _agentName: string | null = null;
let _shutdownHandlersInstalled = false;

// Track which uninitialized-metric warnings we've already logged so we
// emit a single console.warn per metric name (not per call).
const _uninitializedWarned = new Set<string>();

export interface AgentMetricsHandles {
  registry: Registry;
  agentUp: Gauge<'agent'>;
  agentRunsTotal: Counter<'agent' | 'status'>;
  agentRunDuration: Histogram<'agent' | 'status'>;
  agentToolCallsTotal: Counter<'agent' | 'tool' | 'status'>;
  agentToolDuration: Histogram<'agent' | 'tool'>;
  agentLlmCallsTotal: Counter<'agent' | 'model' | 'status'>;
  agentApprovalRequestsTotal: Counter<'agent' | 'outcome'>;
  agentMemoryOpsTotal: Counter<'agent' | 'op'>;
}

export interface InitAgentMetricsOptions {
  agentName: string;
  /** If true (default), install SIGTERM/SIGINT handlers that flip `agent_up` to 0. */
  installShutdownHandlers?: boolean;
}

/**
 * Initialise the shared agent metrics registry. Idempotent — calling
 * twice with the same agent name is a no-op; calling with a different
 * agent name throws (one process should only ever report as one agent).
 *
 * Sets `agent_up{agent}` to 1.
 */
export function initAgentMetrics(opts: InitAgentMetricsOptions): AgentMetricsHandles {
  if (_registry && _agentName && opts.agentName !== _agentName) {
    throw new Error(
      `[agent-metrics] already initialised for agent="${_agentName}", refusing to re-init for "${opts.agentName}"`,
    );
  }

  if (!_registry) {
    _registry = new Registry();
    _agentUp = new Gauge({
      name: 'agent_up',
      help: '1 if the agent process is running, 0 if shutting down',
      labelNames: ['agent'] as const,
      registers: [_registry],
    });
    _agentRunsTotal = new Counter({
      name: 'agent_runs_total',
      help: 'Total agent runs by terminal status',
      labelNames: ['agent', 'status'] as const,
      registers: [_registry],
    });
    _agentRunDuration = new Histogram({
      name: 'agent_run_duration_seconds',
      help: 'Wall-clock duration of a single agent run, in seconds',
      labelNames: ['agent', 'status'] as const,
      buckets: [...RUN_DURATION_BUCKETS],
      registers: [_registry],
    });
    _agentToolCallsTotal = new Counter({
      name: 'agent_tool_calls_total',
      help: 'Total tool invocations performed by the agent, by tool + outcome',
      labelNames: ['agent', 'tool', 'status'] as const,
      registers: [_registry],
    });
    _agentToolDuration = new Histogram({
      name: 'agent_tool_duration_seconds',
      help: 'Wall-clock duration of a single tool execution, in seconds',
      labelNames: ['agent', 'tool'] as const,
      buckets: [...TOOL_DURATION_BUCKETS],
      registers: [_registry],
    });
    _agentLlmCallsTotal = new Counter({
      name: 'agent_llm_calls_total',
      help: 'Total LLM chat() calls issued by the agent, by model + outcome',
      labelNames: ['agent', 'model', 'status'] as const,
      registers: [_registry],
    });
    _agentApprovalRequestsTotal = new Counter({
      name: 'agent_approval_requests_total',
      help: 'Total approval cycles requested by the agent, by outcome',
      labelNames: ['agent', 'outcome'] as const,
      registers: [_registry],
    });
    _agentMemoryOpsTotal = new Counter({
      name: 'agent_memory_ops_total',
      help: 'Total memory operations performed by the agent, by op',
      labelNames: ['agent', 'op'] as const,
      registers: [_registry],
    });
    _agentMetricsUninitialized = new Counter({
      name: 'agent_metrics_uninitialized_total',
      help:
        'Total recorder invocations skipped because initAgentMetrics() was not called — ' +
        'visibility into wiring bugs',
      labelNames: ['metric'] as const,
      registers: [_registry],
    });
  }

  _agentName = opts.agentName;
  _agentUp!.set({ agent: opts.agentName }, 1);

  // Pre-create the counter timeseries for each status so that empty
  // dashboards render `0` instead of "no data".
  for (const status of ALL_STATUSES) {
    _agentRunsTotal!.inc({ agent: opts.agentName, status }, 0);
  }

  const installShutdown = opts.installShutdownHandlers ?? true;
  if (installShutdown && !_shutdownHandlersInstalled) {
    _shutdownHandlersInstalled = true;
    const handler = (signal: NodeJS.Signals) => {
      try {
        markAgentDown();
      } catch {
        // never throw out of a signal handler
      }
      // Don't call process.exit() — let the rest of the app's shutdown
      // path run. Re-emitting once would loop our own listener.
      // eslint-disable-next-line no-console
      console.warn(`[agent-metrics] received ${signal} — agent_up flipped to 0`);
    };
    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
  }

  return {
    registry: _registry!,
    agentUp: _agentUp!,
    agentRunsTotal: _agentRunsTotal!,
    agentRunDuration: _agentRunDuration!,
    agentToolCallsTotal: _agentToolCallsTotal!,
    agentToolDuration: _agentToolDuration!,
    agentLlmCallsTotal: _agentLlmCallsTotal!,
    agentApprovalRequestsTotal: _agentApprovalRequestsTotal!,
    agentMemoryOpsTotal: _agentMemoryOpsTotal!,
  };
}

/**
 * Returns the shared metrics registry. Throws if `initAgentMetrics` was
 * not called first — agents must initialise before mounting `/metrics`.
 */
export function getMetricsRegistry(): Registry {
  if (!_registry) {
    throw new Error(
      '[agent-metrics] getMetricsRegistry() called before initAgentMetrics() — call initAgentMetrics({ agentName }) on startup',
    );
  }
  return _registry;
}

/**
 * Returns the agent name set by the most recent `initAgentMetrics()` call,
 * or null if metrics haven't been initialised yet. Exposed so harness
 * wrappers can attach the correct `agent` label without re-plumbing the
 * name through every callsite.
 */
export function getAgentName(): string | null {
  return _agentName;
}

/**
 * Increment `agent_runs_total{agent,status}` for the configured agent.
 * Called by `AgentReporter` on terminal status transitions.
 */
export function recordAgentRun(status: AgentRunStatus): void {
  if (!_agentRunsTotal || !_agentName) {
    // Reporter constructed without metrics init (e.g. legacy agent that
    // hasn't migrated yet) — silently skip rather than throw mid-run.
    return;
  }
  _agentRunsTotal.inc({ agent: _agentName, status });
}

/**
 * Observe a single agent run's wall-clock duration into
 * `agent_run_duration_seconds{agent,status}`. `seconds` is a float — pass
 * `(Date.now() - start) / 1000` from the caller.
 */
export function recordAgentRunDuration(seconds: number, status: AgentRunStatus): void {
  if (!_agentRunDuration || !_agentName) {
    _noteUninitialized('agent_run_duration_seconds');
    return;
  }
  _agentRunDuration.observe({ agent: _agentName, status }, seconds);
}

/**
 * Increment `agent_tool_calls_total{agent,tool,status}` on a tool
 * invocation outcome.
 */
export function recordAgentToolCall(tool: string, status: 'success' | 'error'): void {
  if (!_agentToolCallsTotal || !_agentName) {
    _noteUninitialized('agent_tool_calls_total');
    return;
  }
  _agentToolCallsTotal.inc({ agent: _agentName, tool, status });
}

/**
 * Observe a single tool execution's wall-clock duration into
 * `agent_tool_duration_seconds{agent,tool}`.
 */
export function recordAgentToolDuration(tool: string, seconds: number): void {
  if (!_agentToolDuration || !_agentName) {
    _noteUninitialized('agent_tool_duration_seconds');
    return;
  }
  _agentToolDuration.observe({ agent: _agentName, tool }, seconds);
}

/**
 * Increment `agent_llm_calls_total{agent,model,status}` on a chat()
 * completion.
 */
export function recordAgentLlmCall(model: string, status: 'success' | 'error'): void {
  if (!_agentLlmCallsTotal || !_agentName) {
    _noteUninitialized('agent_llm_calls_total');
    return;
  }
  _agentLlmCallsTotal.inc({ agent: _agentName, model, status });
}

export type AgentApprovalOutcome = 'approved' | 'rejected' | 'timeout';

/**
 * Increment `agent_approval_requests_total{agent,outcome}` at the end
 * of an approval cycle. `timeout` is reported separately from `rejected`
 * so dashboards can distinguish user inaction from explicit denial.
 */
export function recordAgentApprovalRequest(outcome: AgentApprovalOutcome): void {
  if (!_agentApprovalRequestsTotal || !_agentName) {
    _noteUninitialized('agent_approval_requests_total');
    return;
  }
  _agentApprovalRequestsTotal.inc({ agent: _agentName, outcome });
}

export type AgentMemoryOp = 'recall' | 'remember' | 'forget';

/**
 * Increment `agent_memory_ops_total{agent,op}` on a memory operation.
 * The harness's `noopMemory()` does NOT call this — real `Memory`
 * adapters are expected to invoke it inside their `recall`/`remember`/
 * `forget` implementations.
 */
export function recordAgentMemoryOp(op: AgentMemoryOp): void {
  if (!_agentMemoryOpsTotal || !_agentName) {
    _noteUninitialized('agent_memory_ops_total');
    return;
  }
  _agentMemoryOpsTotal.inc({ agent: _agentName, op });
}

/**
 * Internal helper — bump `agent_metrics_uninitialized_total{metric}`
 * and emit a single console.warn per metric name so misconfigured
 * agents are noisy on first use but quiet afterwards.
 */
function _noteUninitialized(metric: string): void {
  if (!_uninitializedWarned.has(metric)) {
    _uninitializedWarned.add(metric);
    // eslint-disable-next-line no-console
    console.warn(
      `[agent-metrics] ${metric} recorded before initAgentMetrics() — call ignored. ` +
        'Subsequent skipped calls will increment agent_metrics_uninitialized_total without further logs.',
    );
  }
  // The uninitialized-counter itself only exists once initAgentMetrics()
  // has been called, so if even that's missing we can only log. Once the
  // counter exists, every subsequent skipped call increments it.
  _agentMetricsUninitialized?.inc({ metric });
}

/**
 * Flip `agent_up{agent}` to 0. Idempotent. Called by the SIGTERM/SIGINT
 * handler installed by `initAgentMetrics`, and exposed for tests + agents
 * that want to flush during a graceful shutdown sequence.
 */
export function markAgentDown(): void {
  if (_agentUp && _agentName) {
    _agentUp.set({ agent: _agentName }, 0);
  }
}

/**
 * Render the registry to the Prometheus text exposition format. Agents
 * mount this on their own `/metrics` route.
 *
 * @example
 *   import { initAgentMetrics, renderMetrics } from '@petedio/shared/agents';
 *   initAgentMetrics({ agentName: 'ops-investigator' });
 *   app.get('/metrics', async (_req, res) => {
 *     res.setHeader('Content-Type', 'text/plain; version=0.0.4');
 *     res.send(await renderMetrics());
 *   });
 */
export async function renderMetrics(): Promise<string> {
  return getMetricsRegistry().metrics();
}

// ─── Test helper (NOT a public API) ──────────────────────────────
//
// Exported so the unit tests can reset module state between cases.
// Production code should never call this.
export function __resetAgentMetricsForTests(): void {
  _registry?.clear();
  _registry = null;
  _agentUp = null;
  _agentRunsTotal = null;
  _agentRunDuration = null;
  _agentToolCallsTotal = null;
  _agentToolDuration = null;
  _agentLlmCallsTotal = null;
  _agentApprovalRequestsTotal = null;
  _agentMemoryOpsTotal = null;
  _agentMetricsUninitialized = null;
  _agentName = null;
  _uninitializedWarned.clear();
  // Note: shutdown handlers are global on `process` and survive across
  // test resets. That's fine — they're idempotent and skip no-op when
  // _agentUp is null.
}
