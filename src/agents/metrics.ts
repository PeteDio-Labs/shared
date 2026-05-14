/**
 * Shared Prometheus metrics for the agent fleet.
 *
 * Each agent process owns a single metrics Registry. Agents are expected
 * to mount the registry on their own HTTP server at `/metrics` — this
 * module does NOT start a server, it only exposes the registry and
 * metric handles.
 *
 * Metrics:
 *   - `agent_up{agent="<name>"}`            — Gauge, 1 on startup, 0 on shutdown
 *   - `agent_runs_total{agent,status}`      — Counter, increments on terminal status
 *
 * The agent name is supplied via `initAgentMetrics({ agentName })` (called
 * automatically by `AgentReporter`).
 */
import { Counter, Gauge, Registry } from 'prom-client';

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

// ─── Module-level state ──────────────────────────────────────────

let _registry: Registry | null = null;
let _agentUp: Gauge<'agent'> | null = null;
let _agentRunsTotal: Counter<'agent' | 'status'> | null = null;
let _agentName: string | null = null;
let _shutdownHandlersInstalled = false;

export interface AgentMetricsHandles {
  registry: Registry;
  agentUp: Gauge<'agent'>;
  agentRunsTotal: Counter<'agent' | 'status'>;
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
  _agentName = null;
  // Note: shutdown handlers are global on `process` and survive across
  // test resets. That's fine — they're idempotent and skip no-op when
  // _agentUp is null.
}
