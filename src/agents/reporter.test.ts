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
