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
