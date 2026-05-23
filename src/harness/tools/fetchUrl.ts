/**
 * fetchUrl — fetch a URL and return its text content as plain markdown-ish text.
 *
 * Defensive guards:
 * - refuses private/loopback URLs (defence against prompt-injected LAN scans)
 * - bounded redirect chain (max 5 hops)
 * - response truncated at maxBytes (default 50 KB)
 * - dependency-free HTML strip (regex tags + common entity decode)
 *
 * Returns a header (`# <title>`), the extracted text body, and a source
 * footer with the final resolved URL.
 */
import type { Tool, ToolExecContext } from '../tool.js';

export interface FetchUrlOptions {
  timeoutMs?: number;
  /** Hard cap on the bytes returned in the body. Default: 50_000. */
  maxBytes?: number;
}

export interface FetchUrlArgs {
  url: string;
}

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 50_000;

export function fetchUrl(opts: FetchUrlOptions = {}): Tool<FetchUrlArgs> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    name: 'fetch_url',
    description:
      'Fetch a public HTTPS URL and return its plain-text content. Strips HTML, decodes entities, truncates to ~50 KB. Refuses LAN/private addresses. Use for reading docs, blog posts, GitHub READMEs.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to fetch (http or https).' },
      },
      required: ['url'],
    },
    async execute(args, ctx) {
      const raw = (args?.url ?? '').toString().trim();
      if (!raw) return 'fetch_url error: url is required';

      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return `fetch_url error: invalid URL "${raw}"`;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `fetch_url error: unsupported protocol "${parsed.protocol}"`;
      }
      if (isPrivateHost(parsed.hostname)) {
        return 'fetch_url error: refusing to fetch private URL';
      }

      const signal = mergeSignals(ctx.signal, AbortSignal.timeout(timeoutMs));

      let current = parsed.toString();
      let hops = 0;
      try {
        while (hops <= MAX_REDIRECTS) {
          ctx.log?.debug({ url: current, hop: hops }, 'fetch_url: requesting');
          const res = await fetch(current, {
            method: 'GET',
            redirect: 'manual',
            headers: {
              'User-Agent': 'PeteDio-Harness/1.0 (+https://pdlab.dev)',
              Accept: 'text/html, text/plain, application/json;q=0.8, */*;q=0.1',
            },
            signal,
          });

          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) return `fetch_url error: ${res.status} redirect with no Location header`;
            const next = new URL(loc, current);
            if (isPrivateHost(next.hostname)) {
              return 'fetch_url error: redirect target is a private URL';
            }
            current = next.toString();
            hops++;
            continue;
          }

          if (!res.ok) {
            return `fetch_url error: ${res.status} ${res.statusText || ''}`.trim();
          }

          const contentType = res.headers.get('content-type') ?? '';
          const buffer = await readBounded(res, maxBytes);
          const truncated = buffer.truncated;
          const raw = buffer.text;
          const isHtml = /text\/html|application\/xhtml/i.test(contentType) || /<html|<!doctype/i.test(raw.slice(0, 200));
          const title = isHtml ? extractTitle(raw) : '';
          const body = isHtml ? stripHtml(raw) : raw;

          const header = title ? `# ${title}\n\n` : '';
          const footer = `\n\n---\nSource: ${current}${truncated ? ' (truncated)' : ''}`;
          return `${header}${body.trim()}${footer}`;
        }
        return `fetch_url error: exceeded ${MAX_REDIRECTS} redirects`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log?.warn({ err: msg, url: current }, 'fetch_url: request failed');
        return `fetch_url error: ${msg}`;
      }
    },
  };
}

// ─── helpers ────────────────────────────────────────────────────

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '::') return true;
  // IPv4 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (Tailscale)
  }
  // IPv6 literals (rough): private prefixes fc00::/7 and fe80::/10
  if (/^\[?fc[0-9a-f]{2}:/i.test(h) || /^\[?fd[0-9a-f]{2}:/i.test(h)) return true;
  if (/^\[?fe8[0-9a-f]:/i.test(h)) return true;
  // Common internal TLDs
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  return false;
}

async function readBounded(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > maxBytes) return { text: text.slice(0, maxBytes), truncated: true };
    return { text, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total + (truncated ? Math.min(0, 0) : 0));
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(merged), truncated };
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return decodeEntities(m[1] ?? '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html: string): string {
  // Drop script/style blocks first.
  let out = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  out = out.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  // Block-level elements → newline so paragraphs survive.
  out = out.replace(/<\/(p|div|li|h[1-6]|tr|br|hr|article|section|header|footer|table)>/gi, '\n');
  out = out.replace(/<(br|hr)\s*\/?>/gi, '\n');
  // Strip remaining tags.
  out = out.replace(/<[^>]+>/g, '');
  out = decodeEntities(out);
  // Collapse whitespace but preserve paragraph breaks.
  out = out.replace(/[ \t]+/g, ' ');
  out = out.replace(/\n[ \t]+/g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(parseInt(dec, 10)));
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([a, b]);
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  if (a.aborted) ctrl.abort();
  else a.addEventListener('abort', onAbort, { once: true });
  if (b.aborted) ctrl.abort();
  else b.addEventListener('abort', onAbort, { once: true });
  return ctrl.signal;
}
