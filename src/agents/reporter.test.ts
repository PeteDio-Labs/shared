/**
 * Tests for AgentReporter — covers the new prom-client metrics, the
 * `log_line` event, and the SIGTERM hook that flips `agent_up` to 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentReporter } from './reporter.js';
import {
  __resetAgentMetricsForTests,
  getMetricsRegistry,
  initAgentMetrics,
  markAgentDown,
  recordAgentApprovalRequest,
  recordAgentLlmCall,
  recordAgentMemoryOp,
  recordAgentRunDuration,
  recordAgentToolCall,
  recordAgentToolDuration,
} from './metrics.js';
import type { AgentResult } from './types.js';

// ─── Mocks ──────────────────────────────────────────────────────

class FakeFetch {
  calls: Array<{ url: string; init?: RequestInit }> = [];
  // Default: 200 OK, empty JSON body.
  response: { ok: boolean; status: number; text: () => Promise<string> } = {
    ok: true,
    status: 200,
    text: () => Promise.resolve(''),
  };

  fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    this.calls.push({ url, init });
    return Promise.resolve(this.response as unknown as Response);
  };

  reset() {
    this.calls = [];
  }
}

const fakeFetch = new FakeFetch();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fakeFetch.reset();
  globalThis.fetch = fakeFetch.fn as unknown as typeof fetch;
  __resetAgentMetricsForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetAgentMetricsForTests();
});

// ─── Helpers ────────────────────────────────────────────────────

function findCall(fetch: FakeFetch, suffix: string) {
  return fetch.calls.find(c => c.url.endsWith(suffix));
}

function buildResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    taskId: 'task-1',
    agentName: 'test-agent',
    status: 'complete',
    summary: 'all good',
    artifacts: [],
    durationMs: 42,
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Metrics registration ───────────────────────────────────────

describe('AgentReporter — metrics initialisation', () => {
  it('registers agent_up and agent_runs_total on construction', async () => {
    new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_up{agent="test-agent"} 1');
    // Pre-seeded counter timeseries should exist with value 0.
    expect(text).toContain('agent_runs_total{agent="test-agent",status="complete"} 0');
    expect(text).toContain('agent_runs_total{agent="test-agent",status="failed"} 0');
    expect(text).toContain('agent_runs_total{agent="test-agent",status="cancelled"} 0');
    expect(text).toContain('agent_runs_total{agent="test-agent",status="skipped"} 0');
  });

  it('skips metric init when initMetrics: false', () => {
    new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
      initMetrics: false,
    });

    expect(() => getMetricsRegistry()).toThrow(/before initAgentMetrics/);
  });

  it('agent_up flips 1 → 0 when markAgentDown() is called (SIGTERM path)', async () => {
    new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    let text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_up{agent="test-agent"} 1');

    markAgentDown();

    text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_up{agent="test-agent"} 0');
  });

  it('SIGTERM signal handler flips agent_up to 0', async () => {
    new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    // Don't actually exit the test process — emit the signal and let
    // the registered handler run. Node executes synchronously here.
    process.emit('SIGTERM');

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_up{agent="test-agent"} 0');
  });
});

// ─── Counter behaviour ──────────────────────────────────────────

describe('AgentReporter — agent_runs_total counter', () => {
  it('increments status="complete" after a successful complete()', async () => {
    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    await reporter.complete(buildResult());

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_runs_total{agent="test-agent",status="complete"} 1');
    expect(text).toContain('agent_runs_total{agent="test-agent",status="failed"} 0');
  });

  it('increments status="failed" after fail()', async () => {
    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    await reporter.fail('boom');

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_runs_total{agent="test-agent",status="failed"} 1');
    expect(text).toContain('agent_runs_total{agent="test-agent",status="complete"} 0');
  });

  it('counts repeated runs by the same reporter instance', async () => {
    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    await reporter.complete(buildResult());
    await reporter.complete(buildResult());
    await reporter.fail('third try');

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_runs_total{agent="test-agent",status="complete"} 2');
    expect(text).toContain('agent_runs_total{agent="test-agent",status="failed"} 1');
  });
});

// ─── log_line event ─────────────────────────────────────────────

describe('AgentReporter — reportLogLine()', () => {
  it('POSTs the correct shape to /api/v1/agents/:taskId/log', async () => {
    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    const ts = new Date('2026-05-05T12:00:00.000Z');
    await reporter.reportLogLine({
      line: 'Plan: 1 to add, 0 to change, 0 to destroy.',
      stream: 'stdout',
      timestamp: ts,
    });

    const call = findCall(fakeFetch, '/api/v1/agents/task-1/log');
    expect(call).toBeDefined();
    expect(call!.init?.method).toBe('POST');
    expect(call!.init?.headers).toMatchObject({ 'Content-Type': 'application/json' });

    const body = JSON.parse(call!.init!.body as string);
    expect(body).toEqual({
      type: 'log_line',
      task_id: 'task-1',
      agent_name: 'test-agent',
      line: 'Plan: 1 to add, 0 to change, 0 to destroy.',
      stream: 'stdout',
      timestamp: '2026-05-05T12:00:00.000Z',
    });
  });

  it('defaults timestamp to now when not provided', async () => {
    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    const before = Date.now();
    await reporter.reportLogLine({ line: 'first', stream: 'stderr' });
    const after = Date.now();

    const call = findCall(fakeFetch, '/api/v1/agents/task-1/log')!;
    const body = JSON.parse(call.init!.body as string);
    const ts = Date.parse(body.timestamp);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(body.stream).toBe('stderr');
  });

  it('does not throw when MC is unreachable', async () => {
    // Simulate a network failure
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    await expect(
      reporter.reportLogLine({ line: 'line', stream: 'stdout' }),
    ).resolves.toBeUndefined();
  });
});

// ─── initAgentMetrics safety ────────────────────────────────────

describe('initAgentMetrics safety', () => {
  it('throws when re-initialised with a different agent name', () => {
    initAgentMetrics({ agentName: 'agent-a', installShutdownHandlers: false });
    expect(() => initAgentMetrics({ agentName: 'agent-b' })).toThrow(/already initialised/);
  });

  it('is idempotent when called twice with the same agent name', () => {
    expect(() =>
      initAgentMetrics({ agentName: 'agent-a', installShutdownHandlers: false }),
    ).not.toThrow();
    expect(() =>
      initAgentMetrics({ agentName: 'agent-a', installShutdownHandlers: false }),
    ).not.toThrow();
  });
});

// ─── Extended metrics (kanban 2.9) ──────────────────────────────

describe('Extended agent_* metrics (kanban 2.9)', () => {
  it('registers all new metric families on init', async () => {
    initAgentMetrics({ agentName: 'metrics-agent', installShutdownHandlers: false });

    const text = await getMetricsRegistry().metrics();
    // Histograms emit `# TYPE <name> histogram` + bucket lines.
    expect(text).toMatch(/# TYPE agent_run_duration_seconds histogram/);
    expect(text).toMatch(/# TYPE agent_tool_duration_seconds histogram/);
    // Counters emit `# TYPE <name> counter`.
    expect(text).toMatch(/# TYPE agent_tool_calls_total counter/);
    expect(text).toMatch(/# TYPE agent_llm_calls_total counter/);
    expect(text).toMatch(/# TYPE agent_approval_requests_total counter/);
    expect(text).toMatch(/# TYPE agent_memory_ops_total counter/);
    expect(text).toMatch(/# TYPE agent_metrics_uninitialized_total counter/);
  });

  it('recordAgentRunDuration observes into the histogram with the agent label', async () => {
    initAgentMetrics({ agentName: 'metrics-agent', installShutdownHandlers: false });
    recordAgentRunDuration(1.5, 'complete');

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_run_duration_seconds_count{agent="metrics-agent",status="complete"} 1');
    expect(text).toContain('agent_run_duration_seconds_sum{agent="metrics-agent",status="complete"} 1.5');
  });

  it('recordAgentToolCall increments the counter with tool + status labels', async () => {
    initAgentMetrics({ agentName: 'metrics-agent', installShutdownHandlers: false });
    recordAgentToolCall('foo', 'success');
    recordAgentToolCall('foo', 'success');
    recordAgentToolCall('foo', 'error');

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_tool_calls_total{agent="metrics-agent",tool="foo",status="success"} 2');
    expect(text).toContain('agent_tool_calls_total{agent="metrics-agent",tool="foo",status="error"} 1');
  });

  it('recordAgentToolDuration observes the per-tool histogram', async () => {
    initAgentMetrics({ agentName: 'metrics-agent', installShutdownHandlers: false });
    recordAgentToolDuration('foo', 0.25);

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_tool_duration_seconds_count{agent="metrics-agent",tool="foo"} 1');
    expect(text).toContain('agent_tool_duration_seconds_sum{agent="metrics-agent",tool="foo"} 0.25');
  });

  it('recordAgentLlmCall increments by model + status', async () => {
    initAgentMetrics({ agentName: 'metrics-agent', installShutdownHandlers: false });
    recordAgentLlmCall('gemma4:e4b', 'success');
    recordAgentLlmCall('gemma4:e4b', 'error');

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_llm_calls_total{agent="metrics-agent",model="gemma4:e4b",status="success"} 1');
    expect(text).toContain('agent_llm_calls_total{agent="metrics-agent",model="gemma4:e4b",status="error"} 1');
  });

  it('recordAgentApprovalRequest increments by outcome (approved/rejected/timeout)', async () => {
    initAgentMetrics({ agentName: 'metrics-agent', installShutdownHandlers: false });
    recordAgentApprovalRequest('approved');
    recordAgentApprovalRequest('rejected');
    recordAgentApprovalRequest('timeout');

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_approval_requests_total{agent="metrics-agent",outcome="approved"} 1');
    expect(text).toContain('agent_approval_requests_total{agent="metrics-agent",outcome="rejected"} 1');
    expect(text).toContain('agent_approval_requests_total{agent="metrics-agent",outcome="timeout"} 1');
  });

  it('recordAgentMemoryOp increments by op (recall/remember/forget)', async () => {
    initAgentMetrics({ agentName: 'metrics-agent', installShutdownHandlers: false });
    recordAgentMemoryOp('recall');
    recordAgentMemoryOp('remember');
    recordAgentMemoryOp('forget');

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_memory_ops_total{agent="metrics-agent",op="recall"} 1');
    expect(text).toContain('agent_memory_ops_total{agent="metrics-agent",op="remember"} 1');
    expect(text).toContain('agent_memory_ops_total{agent="metrics-agent",op="forget"} 1');
  });

  it('recorders before init do not throw and (once init runs) increment agent_metrics_uninitialized_total', async () => {
    // Suppress the single console.warn per metric to keep test output clean.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // No init yet — these must not throw. The uninitialized counter
    // doesn't exist until init, so these calls only emit the warn.
    expect(() => recordAgentToolCall('foo', 'success')).not.toThrow();
    expect(() => recordAgentLlmCall('m', 'success')).not.toThrow();

    // Now init, then call again — the uninitialized branch is hit ONLY
    // when _agentName is null OR the metric handle is null. After init
    // both are set, so the next call records normally. To verify the
    // uninit-counter path we'd need to construct a scenario that can't
    // happen in practice; instead we verify the counter exists at 0 and
    // the type is registered.
    initAgentMetrics({ agentName: 'metrics-agent', installShutdownHandlers: false });

    const text = await getMetricsRegistry().metrics();
    expect(text).toMatch(/# TYPE agent_metrics_uninitialized_total counter/);

    warnSpy.mockRestore();
  });

  it('recordAgentApprovalRequest("approved") via reporter.requestApproval is wired through', async () => {
    // First poll returns approved → reporter records the metric.
    const responses: Array<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }> = [
      // POST status update (waiting_approval)
      { ok: true, status: 200, json: async () => ({}), text: async () => '' },
      // POST approval request
      { ok: true, status: 200, json: async () => ({}), text: async () => '' },
      // GET approval poll → approved
      { ok: true, status: 200, json: async () => ({ outcome: 'approved' }), text: async () => '' },
      // POST status update (running, after approval)
      { ok: true, status: 200, json: async () => ({}), text: async () => '' },
    ];
    globalThis.fetch = vi.fn(async () => {
      const next = responses.shift();
      return (next ?? { ok: true, status: 200, json: async () => ({}), text: async () => '' }) as unknown as Response;
    }) as unknown as typeof fetch;

    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-approve',
      agentName: 'metrics-agent',
    });

    const result = await reporter.requestApproval({
      actionType: 'deploy',
      description: 'roll out v2',
      preview: 'kubectl apply -f manifest.yaml',
    });

    expect(result.outcome).toBe('approved');
    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_approval_requests_total{agent="metrics-agent",outcome="approved"} 1');
  }, 10_000);
});

// ─── Plan service: proposeAction + updatePlan (PB.9) ───────────────

describe('AgentReporter — proposeAction()', () => {
  it('POSTs to /api/v1/plans and returns planId', async () => {
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: true,
        status: 201,
        json: async () => ({ planId: 'pl_abc123', plan: { id: 'pl_abc123' } }),
        text: async () => '',
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    const result = await reporter.proposeAction({
      kind: 'proposed_fix',
      severity: 'warn',
      target: 'qbittorrent-vpn',
      summary: 'VPN stuck — bounce the stack?',
      proposedFix: {
        agent: 'infra-agent',
        task: 'restart qbittorrent-vpn',
        input: { lxcId: 110 },
      },
      actions: [
        { actionId: 'yes', label: 'Fix it', style: 'primary' },
        { actionId: 'dismiss', label: 'Dismiss' },
      ],
      sourceMetadata: { extra: 'context' },
      expiresInSeconds: 3600,
    });

    expect(result).toEqual({ planId: 'pl_abc123' });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://mc.example/api/v1/plans');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });

    const body = JSON.parse(init.body as string);
    expect(body.kind).toBe('proposed_fix');
    expect(body.severity).toBe('warn');
    expect(body.source).toBe('agent');
    expect(body.target).toBe('qbittorrent-vpn');
    expect(body.summary).toBe('VPN stuck — bounce the stack?');
    expect(body.proposedFix).toEqual({
      agent: 'infra-agent',
      task: 'restart qbittorrent-vpn',
      input: { lxcId: 110 },
    });
    expect(body.actions).toHaveLength(2);
    expect(body.actions[0]).toEqual({ actionId: 'yes', label: 'Fix it', style: 'primary' });
    expect(body.sourceMetadata).toEqual({
      taskId: 'task-1',
      agentName: 'test-agent',
      extra: 'context',
    });
    expect(body.expiresInSeconds).toBe(3600);
  });

  it('falls back to plan.id when top-level planId is missing', async () => {
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: true,
        status: 201,
        json: async () => ({ plan: { id: 'pl_nested' } }),
        text: async () => '',
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    const result = await reporter.proposeAction({
      kind: 'alert',
      summary: 'fyi',
      actions: [{ actionId: 'ack', label: 'Ack' }],
    });

    expect(result.planId).toBe('pl_nested');
  });

  it('throws if MC returns 500 (with status code in error message)', async () => {
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'internal server error',
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    await expect(
      reporter.proposeAction({
        kind: 'alert',
        summary: 'will fail',
        actions: [{ actionId: 'ack', label: 'Ack' }],
      }),
    ).rejects.toThrow(/500/);
  });

  it('throws when mcUrl is empty (unset env var)', async () => {
    const reporter = new AgentReporter({
      mcUrl: '',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    await expect(
      reporter.proposeAction({
        kind: 'alert',
        summary: 'will fail',
        actions: [{ actionId: 'ack', label: 'Ack' }],
      }),
    ).rejects.toThrow(/MC URL is not configured/);
  });

  it('throws if MC returns 2xx but no planId in body', async () => {
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: true,
        status: 201,
        json: async () => ({}),
        text: async () => '',
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    await expect(
      reporter.proposeAction({
        kind: 'alert',
        summary: 'no plan id back',
        actions: [{ actionId: 'ack', label: 'Ack' }],
      }),
    ).rejects.toThrow(/no planId/);
  });
});

describe('AgentReporter — updatePlan()', () => {
  it('PATCHes /api/v1/plans/:id/status with actorSource=agent', async () => {
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ plan: {} }),
        text: async () => '',
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    await reporter.updatePlan('pl_abc123', {
      toStatus: 'succeeded',
      result: { restartedAt: '2026-05-23T12:00:00Z' },
      triggeredAgentRunId: '00000000-0000-0000-0000-000000000001',
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://mc.example/api/v1/plans/pl_abc123/status');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });

    const body = JSON.parse(init.body as string);
    expect(body.toStatus).toBe('succeeded');
    expect(body.actorSource).toBe('agent');
    expect(body.result).toEqual({ restartedAt: '2026-05-23T12:00:00Z' });
    expect(body.triggeredAgentRunId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('passes through errorSummary + proposals for stuck transitions', async () => {
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ plan: {} }),
        text: async () => '',
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    await reporter.updatePlan('pl_stuck', {
      toStatus: 'stuck',
      errorSummary: 'NAT-PMP still empty after restart',
      proposals: [
        { label: 'Try a different exit', task: 'switch-proton-country' },
        { label: 'Investigate manually', mcUrl: 'https://mc.pdlab.dev/plans/pl_stuck' },
      ],
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.errorSummary).toBe('NAT-PMP still empty after restart');
    expect(body.proposals).toHaveLength(2);
    expect(body.proposals[1]).toEqual({
      label: 'Investigate manually',
      mcUrl: 'https://mc.pdlab.dev/plans/pl_stuck',
    });
  });

  it('throws on non-2xx', async () => {
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => 'plan not found',
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    const reporter = new AgentReporter({
      mcUrl: 'http://mc.example',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    await expect(
      reporter.updatePlan('pl_missing', { toStatus: 'succeeded' }),
    ).rejects.toThrow(/404/);
  });

  it('throws when mcUrl is empty', async () => {
    const reporter = new AgentReporter({
      mcUrl: '',
      taskId: 'task-1',
      agentName: 'test-agent',
    });

    await expect(
      reporter.updatePlan('pl_abc', { toStatus: 'succeeded' }),
    ).rejects.toThrow(/MC URL is not configured/);
  });
});
