/**
 * AgentReporter — posts status updates, approval requests, and results back
 * to Mission Control Backend. Gracefully degrades if MC is unreachable.
 */

import type { AgentStatusUpdate, AgentResult, ApprovalRequest, ApprovalResult, GatedAction } from './types.js';

const POLL_INTERVAL_MS = 3_000;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class AgentReporter {
  private mcUrl: string;
  private taskId: string;
  private agentName: string;

  constructor(opts: { mcUrl: string; taskId: string; agentName: string }) {
    this.mcUrl = opts.mcUrl.replace(/\/$/, '');
    this.taskId = opts.taskId;
    this.agentName = opts.agentName;
  }

  async running(message?: string): Promise<void> {
    await this.postStatus({ status: 'running', message });
  }

  async complete(result: AgentResult): Promise<void> {
    await this.postStatus({ status: 'complete', message: result.summary });
    await this.postResult(result);
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
      await fetch(`${this.mcUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // MC unreachable — agent continues regardless, results may be lost
      console.warn(`[reporter] MC unreachable — could not POST ${path}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
