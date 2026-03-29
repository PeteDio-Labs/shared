/**
 * Generic SSE stream listener with auto-reconnect.
 *
 * Handles the raw connect/read/reconnect loop. Callers provide an
 * `onEvent` callback — all business logic (filtering, debouncing,
 * pipeline triggers) stays in the consumer.
 */

export interface SseListenerOptions {
  /** Max reconnect delay in ms (default: 30_000) */
  maxRetryDelayMs?: number;
  /** Initial reconnect delay in ms (default: 1_000) */
  initialRetryDelayMs?: number;
  /** Called with the raw parsed data object for each SSE data line */
  onEvent: (data: unknown) => void;
  /** Optional: called when connection state changes */
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (err: unknown) => void;
}

export class SseListener {
  private stopped = false;
  private retryDelay: number;

  constructor(
    private url: string,
    private options: SseListenerOptions,
  ) {
    this.retryDelay = options.initialRetryDelayMs ?? 1_000;
  }

  start(): void {
    this.stopped = false;
    this.retryDelay = this.options.initialRetryDelayMs ?? 1_000;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.options.onDisconnect?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    try {
      const response = await fetch(this.url, {
        headers: { Accept: 'text/event-stream' },
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      this.options.onConnect?.();
      this.retryDelay = this.options.initialRetryDelayMs ?? 1_000;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            this.options.onEvent(data);
          } catch {
            // Ignore malformed SSE data lines
          }
        }
      }

      this.options.onDisconnect?.();
    } catch (err) {
      this.options.onDisconnect?.();
      this.options.onError?.(err);
    }

    if (!this.stopped) {
      await new Promise(r => setTimeout(r, this.retryDelay));
      this.retryDelay = Math.min(
        this.retryDelay * 2,
        this.options.maxRetryDelayMs ?? 30_000,
      );
      void this.connect();
    }
  }
}
