/**
 * Tests for wrapToolExecution — verifies metric wiring around the Tool
 * interface added in kanban 2.9 (LXC 113 Agent Harness Observability).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { wrapToolExecution, type Tool } from './tool.js';
import {
  __resetAgentMetricsForTests,
  getMetricsRegistry,
  initAgentMetrics,
} from '../agents/metrics.js';

beforeEach(() => {
  __resetAgentMetricsForTests();
  initAgentMetrics({ agentName: 'wrap-agent', installShutdownHandlers: false });
});

afterEach(() => {
  __resetAgentMetricsForTests();
});

function makeTool<TArgs = Record<string, unknown>>(
  name: string,
  fn: (args: TArgs) => Promise<string>,
): Tool<TArgs> {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: 'object', properties: {} },
    async execute(args) {
      return fn(args);
    },
  };
}

describe('wrapToolExecution', () => {
  it('records agent_tool_calls_total{status="success"} on success', async () => {
    const wrapped = wrapToolExecution(makeTool('foo', async () => 'ok'));
    const out = await wrapped.execute({}, {});

    expect(out).toBe('ok');
    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_tool_calls_total{agent="wrap-agent",tool="foo",status="success"} 1');
    expect(text).toContain('agent_tool_duration_seconds_count{agent="wrap-agent",tool="foo"} 1');
  });

  it('records agent_tool_calls_total{status="error"} and re-throws on failure', async () => {
    const wrapped = wrapToolExecution(
      makeTool('bar', async () => {
        throw new Error('boom');
      }),
    );

    await expect(wrapped.execute({}, {})).rejects.toThrow('boom');

    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('agent_tool_calls_total{agent="wrap-agent",tool="bar",status="error"} 1');
    // Duration histogram still observes the failed run.
    expect(text).toContain('agent_tool_duration_seconds_count{agent="wrap-agent",tool="bar"} 1');
  });

  it('preserves name / description / parameters / gate / dryRun', async () => {
    const inner: Tool<Record<string, never>> = {
      name: 'preserved',
      description: 'desc',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return 'inner';
      },
      gate() {
        return { actionType: 'deploy', description: 'gated' };
      },
      async dryRun() {
        return 'dry';
      },
    };
    const wrapped = wrapToolExecution(inner);

    expect(wrapped.name).toBe('preserved');
    expect(wrapped.description).toBe('desc');
    expect(wrapped.parameters).toEqual(inner.parameters);
    expect(wrapped.gate?.({})).toEqual({ actionType: 'deploy', description: 'gated' });
    expect(await wrapped.dryRun?.({}, {})).toBe('dry');
  });

  it('returns the same output as the inner tool', async () => {
    const wrapped = wrapToolExecution(
      makeTool<{ n: number }>('add-one', async ({ n }) => String(n + 1)),
    );
    expect(await wrapped.execute({ n: 41 }, {})).toBe('42');
  });
});
