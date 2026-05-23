/**
 * LlmClient — thin wrapper around ollama-gateway with direct-ollama fallback.
 *
 * Default: hits the gateway at OLLAMA_GATEWAY_URL (or http://localhost:3006).
 * On connection refused, falls back to resolveOllamaUrl(model) so an agent
 * stays functional during gateway maintenance.
 */

import { resolveOllamaUrl } from '../agents/ollamaRouter.js';
import { recordAgentLlmCall } from '../agents/metrics.js';
import type { ToolDef } from '../agents/loop.js';

const DEFAULT_GATEWAY_URL = 'http://localhost:3006';

export interface LlmClientOptions {
  gatewayUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatRequest {
  model?: string;             // overrides defaultModel
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
}

export interface ChatResponse {
  message: ChatMessage;
  model: string;
  done: boolean;
}

export class LlmClient {
  private readonly gatewayUrl: string;
  private readonly defaultModel: string | undefined;
  private readonly timeoutMs: number;
  private gatewayDown = false;
  private gatewayDownUntil = 0;

  constructor(opts: LlmClientOptions = {}) {
    this.gatewayUrl = (opts.gatewayUrl ?? process.env.OLLAMA_GATEWAY_URL ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
    this.defaultModel = opts.defaultModel ?? process.env.OLLAMA_MODEL;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model ?? this.defaultModel;
    if (!model) throw new Error('LlmClient.chat: model not provided and no default');

    try {
      const out = await this._chatInner(model, req);
      recordAgentLlmCall(model, 'success');
      return out;
    } catch (err) {
      recordAgentLlmCall(model, 'error');
      throw err;
    }
  }

  private async _chatInner(model: string, req: ChatRequest): Promise<ChatResponse> {
    const body = {
      model,
      messages: req.messages,
      tools: req.tools,
      stream: false,
      ...(req.temperature !== undefined ? { options: { temperature: req.temperature } } : {}),
    };

    const target = this.pickTarget(model);
    const res = await fetch(`${target}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err: unknown) => {
      // Gateway connection refused → mark down for 30s and try direct
      if (target === this.gatewayUrl && isConnRefused(err)) {
        this.markGatewayDown();
        return null;
      }
      throw err;
    });

    if (!res) {
      // Retry once via direct upstream
      const direct = resolveOllamaUrl(model);
      const fallback = await fetch(`${direct}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return fallback.json() as Promise<ChatResponse>;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`LlmClient.chat: ${res.status} ${errText.slice(0, 200)}`);
    }

    return res.json() as Promise<ChatResponse>;
  }

  private pickTarget(model: string): string {
    if (this.gatewayDown && Date.now() < this.gatewayDownUntil) {
      return resolveOllamaUrl(model);
    }
    if (this.gatewayDown) {
      // 30s window passed — try gateway again
      this.gatewayDown = false;
    }
    return this.gatewayUrl;
  }

  private markGatewayDown(): void {
    this.gatewayDown = true;
    this.gatewayDownUntil = Date.now() + 30_000;
  }
}

function isConnRefused(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('econnrefused') || msg.includes('fetch failed') || msg.includes('connection refused');
}
