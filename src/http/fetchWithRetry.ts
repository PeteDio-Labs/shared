/**
 * Fetch with exponential backoff retry.
 * Retries on network errors only — HTTP error responses are returned as-is.
 */

export interface RetryOptions {
  retries?: number;
  /** Base delay in ms — doubles each attempt (default: 1000) */
  baseDelayMs?: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const { retries = 3, baseDelayMs = 1000, onRetry } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      onRetry?.(attempt, err);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw new Error('fetchWithRetry: unreachable');
}
