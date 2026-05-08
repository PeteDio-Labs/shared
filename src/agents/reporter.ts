/**
 * AgentReporter — posts status updates, approval requests, and results back
 * to Mission Control Backend. Gracefully degrades if MC is unreachable.
 */

import type { AgentStatusUpdate, AgentResult, ApprovalRequest, ApprovalResult, GatedAction } from './types.js';
import { initAgentMetrics, recordAgentRun, type AgentRunStatus } from './metrics.js';

const POLL_INTERVAL_MS = 3_000;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface AgentReporterOptions {
  mcUrl: string;
  taskId: string;
  agentName: string;
  /**
   * Initialise the shared `@petedio/shared/agents` Prometheus registry on
   * construction (sets `agent_up{agent}` to 1, installs SIGTERM/SIGINT
   * handlers, and lets the reporter increment `agent_runs_total`).
   *
   * Default: true. Pass `false` if the agent's process owns metrics
   * lifecycle separately (e.g. a long-lived process that creates one
   * reporter per task).
   */
  initMetrics?: boolean;
}

export class AgentReporter {
  private mcUrl: string;
  private taskId: string;
  private agentName: string;

  constructor(opts: AgentReporterOptions) {
    this.mcUrl = opts.mcUrl.replace(/\/$/, '');
    this.taskId = opts.taskId;
    this.agentName = opts.agentName;

    if (opts.initMetrics ?? true) {
      // Idempotent — repeated reporters for the same agent name reuse
      // the existing registry. Different agent names within one process
      // will throw, which is the right safety behaviour.
      initAgentMetrics({ agentName: opts.agentName });
    }
  }

  async running(message?: string): Promise<void> {
    await this.postStatus({ status: 'running', message });
  }

  async complete(result: AgentResult): Promise<void> {
    await this.postStatus({ status: 'complete', message: result.summary });
    await this.postResult(result);
    recordAgentRun(this.statusToMetric(result.status));
  }

  async fail(error: string): Promise<void> {
    await this.postStatus({ status: 'failed', message: error });
    await this.postResult({
      taskId: this.taskId,
      agentName: this.agentName,
      status: 'failed',
      summary: error,
      artifacts: [],
      durationMs: 0,
      completedAt: new Date().toISOString(),
    });
    recordAgentRun('failed');
  }

  /**
   * Stream a single line of agent stdout/stderr back to Mission Control
   * so MC can drive the SSE live-tail (Wave 4.4).
   *
   * The MC backend may not yet have a handler for this path — agents
   * still call `reportLogLine` regardless; the underlying `post()`
   * gracefully no-ops on 404 / unreachable MC, matching the existing
   * status / approval semantics.
   */
  async reportLogLine(args: {
    line: string;
    stream: 'stdout' | 'stderr';
    timestamp?: Date;
  }): Promise<void> {
    const body = {
      type: 'log_line' as const,
      task_id: this.taskId,
      agent_name: this.agentName,
      line: args.line,
      stream: args.stream,
      timestamp: (args.timestamp ?? new Date()).toISOString(),
    };
    await this.post(`/api/v1/agents/${this.taskId}/log`, body);
  }

  /**
   * Request approval for a gated action. Blocks (polls MC) until approved/rejected
   * or timeout. Returns the outcome so the caller decides whether to proceed.
   */
  async requestApproval(action: GatedAction): Promise<ApprovalResult> {
    const request: ApprovalRequest = {
      taskId: this.taskId,
      agentName: this.agentName,
      action,
      requestedAt: new Date().toISOString(),
    };

    // Post approval request + update status
    await this.postStatus({ status: 'waiting_approval', message: action.description, requiresApproval: action });
    await this.post(`/api/v1/agents/${this.taskId}/approval`, request);

    // Poll for decision
    const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const res = await fetch(`${this.mcUrl}/api/v1/agents/${this.taskId}/approval`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          const data = await res.json() as { outcome?: string; token?: string; reason?: string };
          if (data.outcome === 'approved' || data.outcome === 'rejected') {
            await this.running(`Approval ${data.outcome} — resuming`);
            return { outcome: data.outcome as 'approved' | 'rejected', token: data.token, reason: data.reason };
          }
        }
      } catch {
        // MC unreachable — keep polling
      }
    }

    return { outcome: 'rejected', reason: 'Approval timeout (10 min)' };
  }

  private async postStatus(update: Omit<AgentStatusUpdate, 'taskId' | 'agentName' | 'updatedAt'>): Promise<void> {
    const body: AgentStatusUpdate = {
      taskId: this.taskId,
      agentName: this.agentName,
      updatedAt: new Date().toISOString(),
      ...update,
    };
    await this.post(`/api/v1/agents/${this.taskId}/status`, body);
  }

  private async postResult(result: AgentResult): Promise<void> {
    await this.post(`/api/v1/agents/${this.taskId}/result`, result);
  }

  private async post(path: string, body: unknown): Promise<void> {
    try {
      const res = await fetch(`${this.mcUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[reporter] MC rejected POST ${path} — ${res.status}: ${text.slice(0, 200)}`);
      }
    } catch {
      // MC unreachable — agent continues regardless, results may be lost
      console.warn(`[reporter] MC unreachable — could not POST ${path}`);
    }
  }

  // AgentResult.status is a stricter `complete | failed` union; the
  // metric label set is a wider `complete | failed | cancelled | skipped`.
  // Today the reporter only emits the first two from this method; the
  // wider type lives on the metric for forward-compat with cancellation /
  // gate-skipped runs in a future stream.
  private statusToMetric(status: AgentResult['status']): AgentRunStatus {
    return status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
