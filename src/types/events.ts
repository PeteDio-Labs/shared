/**
 * Canonical InfraEvent types — single source of truth across all services.
 * Mirrors notification-service/src/types.ts (the authoritative schema).
 */

export type EventSource = 'kubernetes' | 'proxmox' | 'argocd';

export type EventType =
  | 'deployment'
  | 'pod-failure'
  | 'vm-status'
  | 'lxc-status'
  | 'sync-drift'
  | 'node-status'
  | 'rollout';

export type Severity = 'info' | 'warning' | 'critical';

export interface InfraEventInput {
  source: EventSource;
  type: EventType;
  severity: Severity;
  message: string;
  namespace?: string;
  affected_service?: string;
  metadata?: Record<string, unknown>;
}

export interface InfraEvent extends InfraEventInput {
  id?: string;
  timestamp?: string;
  processed?: boolean;
}
