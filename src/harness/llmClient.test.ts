/**
 * Tests for LlmClient — verifies the metric wiring added in kanban 2.9
 * (LXC 113 Agent Harness Observability). The actual network paths are
 * covered indirectly via fetch-mocking; this file focuses on the metric
 * contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LlmClient } from './llmClient.js';
import {
  __resetAgentMetricsForTests,
  getMetricsRegistry,
  initAgentMetrics,
} from '../agents/metrics.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetAgentMetricsForTests();
  initAgentMetrics({ agentName: 'llm-agent', installShutdownHandlers: false });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetAgentMetricsForTests();
});

describe('LlmClient — metric wiring (kanban 2.9)', () => {
  it('records agent_llm_calls_total{status="success"} on a 200 response', async () => {
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ message: { role: 'assistant', content: 'hi' }, model: 'gemma4:e4b', done: true }),
        text: async () => '',
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    const client = new LlmClient({ defaultModel: 'gemma4:e4b' });
    const out = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(out.message.content).toBe('hi');

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain(
      'agent_llm_calls_total{agent="llm-agent",model="gemma4:e4b",status="success"} 1',
    );
  });

  it('records agent_llm_calls_total{status="error"} on a non-OK response', async () => {
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'upstream exploded',
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    const client = new LlmClient({ defaultModel: 'gemma4:e4b' });
    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/500/);

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain(
      'agent_llm_calls_total{agent="llm-agent",model="gemma4:e4b",status="error"} 1',
    );
  });
});
