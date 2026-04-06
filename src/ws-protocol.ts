// WebSocket message protocol between backend and web/desktop clients
import { z } from 'zod';
import type { SensingSnapshot, FusedFrameJSON, ActivityEvent, NodeState } from './types.js';

// ── Message types ─────────────────────────────────────────────────────────

export type WsMessageType =
  | 'sensing'       // Full sensing snapshot (presence + motion + vitals + nodes)
  | 'fused_frame'   // Raw fused frame (for clients that want to do their own processing)
  | 'activity'      // Ollama-narrated activity event
  | 'node_update'   // Node state change (online/offline)
  | 'ping'
  | 'pong';

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  ts: number;
  data: T;
}

export type WsSensingMessage = WsMessage<SensingSnapshot>;
export type WsFusedFrameMessage = WsMessage<FusedFrameJSON>;
export type WsActivityMessage = WsMessage<ActivityEvent>;
export type WsNodeUpdateMessage = WsMessage<NodeState[]>;
export type WsPingMessage = WsMessage<null>;
export type WsPongMessage = WsMessage<{ latency_ms: number }>;

// ── Zod schemas for validation ────────────────────────────────────────────

export const WsMessageSchema = z.object({
  type: z.enum(['sensing', 'fused_frame', 'activity', 'node_update', 'ping', 'pong']),
  ts: z.number(),
  data: z.unknown(),
});

// ── Helpers ───────────────────────────────────────────────────────────────

export function makeWsMessage<T>(type: WsMessageType, data: T): WsMessage<T> {
  return { type, ts: Date.now(), data };
}

export function parseWsMessage(raw: string): WsMessage | null {
  try {
    const parsed = JSON.parse(raw);
    const result = WsMessageSchema.safeParse(parsed);
    return result.success ? result.data as WsMessage : null;
  } catch {
    return null;
  }
}
