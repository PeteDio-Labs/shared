/**
 * webSearch — query the in-cluster web-search-service.
 *
 * Default target is the K8s ClusterIP DNS at
 *   http://web-search.web-search.svc.cluster.local:3003
 * which exposes POST /api/v1/search with the shape from
 * apps/web-search-service/src/types.ts (SearchRequestSchema).
 *
 * Override via the `serviceUrl` option or the `WEB_SEARCH_URL` env var.
 * From outside the cluster (LXC 113 agents), point this at the MC
 * proxy: `${MC_BACKEND_URL}/api/v1/web-search` — MEMORY.md notes the
 * proxy route exists for research-agent's flow.
 *
 * Returns a numbered, plain-text result list the LLM can reason about.
 */
import type { Tool, ToolExecContext } from '../tool.js';

export interface WebSearchOptions {
  /**
   * Base URL of the web-search service. The tool appends the search
   * path (`/api/v1/search`) unless the URL already ends in `/search`
   * (in which case it's used verbatim — supports MC proxy routes that
   * already include the full path).
   */
  serviceUrl?: string;
  /** Request timeout in ms. Default: 20_000. */
  timeoutMs?: number;
}

export interface WebSearchArgs {
  query: string;
  limit?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  score?: number;
}

interface SearchResponse {
  query: string;
  provider?: string;
  results: SearchResult[];
  metadata?: { durationMs?: number; fallbackUsed?: boolean; providersAttempted?: string[] };
}

const DEFAULT_SERVICE_URL = 'http://web-search.web-search.svc.cluster.local:3003';
const SEARCH_PATH = '/api/v1/search';

export function webSearch(opts: WebSearchOptions = {}): Tool<WebSearchArgs> {
  const rawBase = (opts.serviceUrl ?? process.env.WEB_SEARCH_URL ?? DEFAULT_SERVICE_URL).replace(
    /\/+$/,
    '',
  );
  // If the configured URL already targets a search endpoint (e.g. MC proxy
  // route `/api/v1/web-search`), don't double up; otherwise append `/api/v1/search`.
  const url = /\/(api\/v1\/)?(web-)?search$/.test(rawBase) ? rawBase : `${rawBase}${SEARCH_PATH}`;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  return {
    name: 'web_search',
    description:
      'Search the web via the in-cluster web-search-service. Returns a numbered list of top hits with title, snippet, and URL. Use for current events, third-party docs, anything not in the internal knowledge base.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query. Be specific.' },
        limit: { type: 'number', description: 'Max results (1-20). Default 5.' },
      },
      required: ['query'],
    },
    async execute(args, ctx) {
      const query = (args?.query ?? '').toString().trim();
      if (!query) return 'web_search error: query is required';
      const limit = clampLimit(args?.limit);

      const signal = mergeSignals(ctx.signal, AbortSignal.timeout(timeoutMs));

      try {
        ctx.log?.debug({ url, query, limit }, 'web_search: dispatching');
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, maxResults: limit }),
          signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return `web_search error: ${res.status} ${text.slice(0, 200)}`;
        }

        const data = (await res.json()) as SearchResponse;
        return formatResults(query, data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log?.warn({ err: msg }, 'web_search: request failed');
        return `web_search error: ${msg}`;
      }
    },
  };
}

function clampLimit(input: unknown): number {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(20, Math.trunc(n)));
}

function formatResults(query: string, data: SearchResponse): string {
  const results = Array.isArray(data?.results) ? data.results : [];
  if (results.length === 0) {
    return `web_search: no results for "${query}".`;
  }
  const header = `web_search results for "${query}" (${results.length}${
    data.provider ? `, via ${data.provider}` : ''
  }):`;
  const body = results
    .map((r, i) => {
      const title = (r.title ?? '(untitled)').trim();
      const snippet = (r.snippet ?? '').trim().replace(/\s+/g, ' ');
      const url = r.url ?? '';
      return `${i + 1}. ${title}\n   ${snippet}\n   ${url}`;
    })
    .join('\n');
  return `${header}\n${body}`;
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  // Native `AbortSignal.any` is available in Node 20+/Bun.
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([a, b]);
  // Fallback: cooperatively abort `b` when `a` fires.
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  if (a.aborted) ctrl.abort();
  else a.addEventListener('abort', onAbort, { once: true });
  if (b.aborted) ctrl.abort();
  else b.addEventListener('abort', onAbort, { once: true });
  return ctrl.signal;
}

// Re-export ToolExecContext for completeness if downstream consumers want it.
export type { ToolExecContext };
