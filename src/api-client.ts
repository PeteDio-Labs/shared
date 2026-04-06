// Typed REST API client for pete-vision-backend
import type { SensingSnapshot, NodeState, ActivityEvent, VitalSigns } from './types.js';

export interface ApiClientConfig {
  baseUrl: string;
  timeoutMs?: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

async function apiFetch<T>(url: string, options?: RequestInit, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

export class PeteVisionApiClient {
  private readonly base: string;
  private readonly timeout: number;

  constructor({ baseUrl, timeoutMs = 10_000 }: ApiClientConfig) {
    this.base = baseUrl.replace(/\/$/, '');
    this.timeout = timeoutMs;
  }

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  /** GET /health */
  async health(): Promise<{ status: string; uptime_ms: number }> {
    return apiFetch(this.url('/health'), undefined, this.timeout);
  }

  /** GET /api/v1/sensing/latest */
  async getLatest(): Promise<SensingSnapshot> {
    return apiFetch(this.url('/api/v1/sensing/latest'), undefined, this.timeout);
  }

  /** GET /api/v1/sensing/history?limit=N */
  async getHistory(limit = 100): Promise<SensingSnapshot[]> {
    return apiFetch(this.url(`/api/v1/sensing/history?limit=${limit}`), undefined, this.timeout);
  }

  /** GET /api/v1/vitals */
  async getVitals(): Promise<VitalSigns> {
    return apiFetch(this.url('/api/v1/vitals'), undefined, this.timeout);
  }

  /** GET /api/v1/nodes */
  async getNodes(): Promise<NodeState[]> {
    return apiFetch(this.url('/api/v1/nodes'), undefined, this.timeout);
  }

  /** GET /api/v1/activity?limit=N */
  async getActivity(limit = 20): Promise<ActivityEvent[]> {
    return apiFetch(this.url(`/api/v1/activity?limit=${limit}`), undefined, this.timeout);
  }

  /** POST /api/v1/ask — natural language query */
  async ask(query: string): Promise<{ answer: string; context: SensingSnapshot }> {
    return apiFetch(
      this.url('/api/v1/ask'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      },
      30_000,
    );
  }
}
