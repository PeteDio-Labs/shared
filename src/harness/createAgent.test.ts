/**
 * Tests for the harness createAgent() factory — covers 1.5.1 patch fixes:
 *   - Fix 2: metrics initialised at construction (not lazy inside handleRun)
 *   - Fix 3: /readyz route returns 200 once metrics are live
 *   - Fix 4: Tool.execute(args, {}) typechecks with optional ToolExecContext
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAgent } from './createAgent.js';
import type { Tool } from './tool.js';
import { __resetAgentMetricsForTests } from '../agents/metrics.js';
import type { AgentResult } from '../agents/types.js';

// ─── Helpers ────────────────────────────────────────────────────

// Use a non-loopback-conflicting port range high above the agent fleet.
let nextPort = 39_900;
function freePort(): number {
  return nextPort++;
}

const TaskSchema = z.object({ note: z.string().optional() });
type TaskInput = z.infer<typeof TaskSchema>;

async function buildAgent(name: string) {
  const port = freePort();
  const handle = createAgent<TaskInput>({
    name,
    model: 'test-model',
    port,
    mode: 'deterministic',
    taskSchema: TaskSchema,
    async run({ payload }): Promise<AgentResult> {
      return {
        taskId: payload.taskId,
        agentName: name,
        status: 'complete',
        summary: 'ok',
        artifacts: [],
        durationMs: 1,
        completedAt: new Date().toISOString(),
      };
    },
  });
  const server = await handle.start();
  return { handle, server, port };
}

beforeEach(() => {
  __resetAgentMetricsForTests();
});

afterEach(() => {
  __resetAgentMetricsForTests();
});

// ─── Fix 2: metrics ready before any /run ───────────────────────

describe('createAgent — eager metrics initialisation (kanban 2.13)', () => {
  it('scraping /metrics before any /run returns agent_up{agent}=1', async () => {
    const { server, port } = await buildAgent('test-agent');

    try {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('agent_up{agent="test-agent"} 1');
      // Pre-seeded counters should be present at 0.
      expect(body).toContain('agent_runs_total{agent="test-agent",status="complete"} 0');
      expect(body).toContain('agent_runs_total{agent="test-agent",status="failed"} 0');
    } finally {
      await server.close();
    }
  });
});

// ─── Fix 3: /readyz route ───────────────────────────────────────

describe('createAgent — /readyz route (kanban 2.14)', () => {
  it('returns 200 ready once metrics are initialised', async () => {
    const { server, port } = await buildAgent('ready-agent');

    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; agent: string };
      expect(body).toEqual({ status: 'ready', agent: 'ready-agent' });
    } finally {
      await server.close();
    }
  });
});

// ─── Fix 4: Tool.execute accepts empty ctx ──────────────────────

describe('Tool — execute(args, {}) without signal (kanban 2.15)', () => {
  it('tsc-level: tool with optional ctx compiles + runs', async () => {
    const tool: Tool<Record<string, never>> = {
      name: 'noop',
      description: 'noop',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return 'ok';
      },
    };

    // The critical assertion is at compile time: calling execute with
    // {} (no reporter, no log, no signal) must typecheck. The runtime
    // assertion below just exercises the path.
    const out = await tool.execute({}, {});
    expect(out).toBe('ok');
  });

  it('tool may default the signal internally when caller omits it', async () => {
    const tool: Tool<Record<string, never>> = {
      name: 'with-signal',
      description: 'demonstrates ctx.signal ?? default pattern',
      parameters: { type: 'object', properties: {} },
      async execute(_args, ctx) {
        const signal = ctx.signal ?? AbortSignal.timeout(100);
        return signal.aborted ? 'aborted' : 'ok';
      },
    };

    const out = await tool.execute({}, {});
    expect(out).toBe('ok');
  });
});
