/**
 * Standard HTTP server scaffolding for harnessed agents.
 *
 * In Phase 5 these get folded into ONE process serving multiple agents
 * (POST /agents/:name/run). For Phase 3 pilot, each agent still runs as
 * its own systemd unit on its own port — this file supports that mode.
 */

import express, { type Application } from 'express';
import type pino from 'pino';
import { renderMetrics } from '../agents/metrics.js';

// Internal flag toggled by tests + the metrics module via the existing
// init path. We avoid importing the private `_registry` symbol; instead we
// detect readiness by trying to render the registry — if it throws, the
// agent hasn't initialised yet (createAgent does this at construction now,
// so in production this branch is only hit during the brief window before
// startStandaloneAgentServer's listen callback fires).
async function isMetricsReady(): Promise<boolean> {
  try {
    await renderMetrics();
    return true;
  } catch {
    return false;
  }
}

export interface ServerOptions {
  port: number;
  agentName: string;
  log: pino.Logger;
  onRun: (body: unknown) => Promise<{ status: number; body: unknown }>;
  onHealth?: () => Record<string, unknown>;
}

export interface ServerHandle {
  app: Application;
  close(): Promise<void>;
}

export function startStandaloneAgentServer(opts: ServerOptions): Promise<ServerHandle> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));

    app.post('/run', async (req, res) => {
      try {
        const result = await opts.onRun(req.body);
        res.status(result.status).json(result.body);
      } catch (err) {
        opts.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'unhandled error in /run',
        );
        res.status(500).json({ error: 'internal error' });
      }
    });

    app.get('/healthz', (_req, res) => {
      res.json({
        status: 'ok',
        agent: opts.agentName,
        ...(opts.onHealth?.() ?? {}),
      });
    });

    // /readyz mirrors the K8s readiness probe contract: 200 once the
    // metrics registry is wired (which now happens at createAgent()
    // construction), 503 otherwise. K8s pulls this pod out of the
    // Service endpoints until /readyz flips green.
    app.get('/readyz', async (_req, res) => {
      if (await isMetricsReady()) {
        res.status(200).json({ status: 'ready', agent: opts.agentName });
      } else {
        res.status(503).json({
          status: 'not-ready',
          agent: opts.agentName,
          reason: 'metrics registry not initialised',
        });
      }
    });

    app.get('/metrics', async (_req, res) => {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.send(await renderMetrics());
    });

    const server = app.listen(opts.port, () => {
      opts.log.info({ port: opts.port, agent: opts.agentName }, 'harness agent listening');
      resolve({
        app,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
