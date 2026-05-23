/**
 * Tests for the shared harness tools — covers the bits that don't
 * require live external services:
 *   - webSearch happy-path / error / no-results formatting (fake fetch)
 *   - ragQuery stub message shape
 *   - fetchUrl private-host guard
 *   - fetchUrl HTML strip + title extract
 *   - searchKnowledge against a temp dir
 *   - codeReview stub echo
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { webSearch } from './webSearch.js';
import { ragQuery } from './ragQuery.js';
import { fetchUrl } from './fetchUrl.js';
import { searchKnowledge } from './searchKnowledge.js';
import { codeReview } from './codeReview.js';
import type { ToolExecContext } from '../tool.js';

const originalFetch = globalThis.fetch;

function makeCtx(): ToolExecContext {
  const noop = (): void => {};
  const log = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    trace: noop,
    silent: noop,
    level: 'info',
    isLevelEnabled: () => true,
    bindings: () => ({}),
    flush: noop,
    setBindings: noop,
  } as unknown as ToolExecContext['log'];
  const childLog = log as unknown as { child(_b: unknown): unknown };
  (childLog as { child(_b: unknown): unknown }).child = () => log;
  return {
    log,
    signal: new AbortController().signal,
    reporter: {} as ToolExecContext['reporter'],
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── webSearch ──────────────────────────────────────────────────

describe('webSearch', () => {
  it('formats results into a numbered list', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        query: 'foo',
        provider: 'searxng',
        results: [
          { title: 'First', url: 'https://example.com/1', snippet: 'A snippet.' },
          { title: 'Second', url: 'https://example.com/2', snippet: 'Another snippet.' },
        ],
      }),
    }) as unknown as typeof fetch;

    const tool = webSearch({ serviceUrl: 'http://fake:3003' });
    const out = await tool.execute({ query: 'foo' }, makeCtx());
    expect(out).toContain('web_search results for "foo"');
    expect(out).toContain('1. First');
    expect(out).toContain('https://example.com/1');
    expect(out).toContain('2. Second');
  });

  it('returns a "no results" message when results array is empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ query: 'foo', results: [] }),
    }) as unknown as typeof fetch;

    const tool = webSearch({ serviceUrl: 'http://fake:3003' });
    const out = await tool.execute({ query: 'foo' }, makeCtx());
    expect(out).toMatch(/no results/i);
  });

  it('returns an error string (no throw) on non-2xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'unavailable',
    }) as unknown as typeof fetch;

    const tool = webSearch({ serviceUrl: 'http://fake:3003' });
    const out = await tool.execute({ query: 'foo' }, makeCtx());
    expect(out.startsWith('web_search error:')).toBe(true);
    expect(out).toContain('503');
  });

  it('returns an error string on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const tool = webSearch({ serviceUrl: 'http://fake:3003' });
    const out = await tool.execute({ query: 'foo' }, makeCtx());
    expect(out.startsWith('web_search error:')).toBe(true);
    expect(out).toContain('ECONNREFUSED');
  });

  it('errors when query is empty', async () => {
    const tool = webSearch({ serviceUrl: 'http://fake:3003' });
    const out = await tool.execute({ query: '' }, makeCtx());
    expect(out).toBe('web_search error: query is required');
  });

  it('does not double-append /api/v1/search when URL ends with /search', async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ query: 'foo', results: [] }),
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    const tool = webSearch({ serviceUrl: 'http://mc.local/api/v1/web-search' });
    await tool.execute({ query: 'foo' }, makeCtx());
    expect(spy).toHaveBeenCalledTimes(1);
    const calledUrl = spy.mock.calls[0]![0] as string;
    expect(calledUrl).toBe('http://mc.local/api/v1/web-search');
  });
});

// ─── ragQuery ───────────────────────────────────────────────────

describe('ragQuery', () => {
  it('returns the structured stub message including the question', async () => {
    const tool = ragQuery();
    const out = await tool.execute({ question: 'what is petedio?' }, makeCtx());
    expect(out).toContain('RAG unavailable');
    expect(out).toContain('Phase 9');
    expect(out).toContain('"what is petedio?"');
    expect(out).toContain('search_knowledge');
  });

  it('errors when question is empty', async () => {
    const tool = ragQuery();
    const out = await tool.execute({ question: '' }, makeCtx());
    expect(out).toBe('rag_query error: question is required');
  });
});

// ─── fetchUrl ───────────────────────────────────────────────────

describe('fetchUrl', () => {
  it('refuses private IPv4 hosts', async () => {
    const tool = fetchUrl();
    for (const url of [
      'http://192.168.50.1/path',
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://127.0.0.1:8080/',
      'http://localhost/',
      'http://kube.local/',
    ]) {
      const out = await tool.execute({ url }, makeCtx());
      expect(out, `expected refusal for ${url}`).toMatch(/refusing to fetch private URL/);
    }
  });

  it('errors on missing url', async () => {
    const tool = fetchUrl();
    const out = await tool.execute({ url: '' }, makeCtx());
    expect(out).toBe('fetch_url error: url is required');
  });

  it('errors on invalid URL', async () => {
    const tool = fetchUrl();
    const out = await tool.execute({ url: 'not-a-url' }, makeCtx());
    expect(out.startsWith('fetch_url error:')).toBe(true);
  });

  it('errors on unsupported protocol', async () => {
    const tool = fetchUrl();
    const out = await tool.execute({ url: 'ftp://example.com/' }, makeCtx());
    expect(out).toMatch(/unsupported protocol/);
  });

  it('extracts title, strips HTML, includes source footer', async () => {
    const html = `<!doctype html><html><head><title>Hello &amp; goodbye</title></head>
<body><script>alert('x')</script><h1>Heading</h1>
<p>Hello <b>world</b> &mdash; testing.</p><p>Another para.</p></body></html>`;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: streamFromString(html),
    } as unknown as Response) as unknown as typeof fetch;

    const tool = fetchUrl();
    const out = await tool.execute({ url: 'https://example.com/page' }, makeCtx());
    expect(out).toContain('# Hello & goodbye');
    expect(out).toContain('Heading');
    expect(out).toContain('Hello world');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<p>');
    expect(out).toContain('Source: https://example.com/page');
  });

  it('refuses to follow a redirect to a private host', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'http://192.168.50.1/' }),
      body: streamFromString(''),
    } as unknown as Response) as unknown as typeof fetch;

    const tool = fetchUrl();
    const out = await tool.execute({ url: 'https://example.com/page' }, makeCtx());
    expect(out).toMatch(/redirect target is a private URL/);
  });
});

// ─── searchKnowledge ────────────────────────────────────────────

describe('searchKnowledge', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'sk-test-'));
    await mkdir(path.join(tmpRoot, 'knowledge'), { recursive: true });
    await mkdir(path.join(tmpRoot, 'planning'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'knowledge', 'gateway.md'),
      [
        '# Gateway notes',
        '',
        'The Ollama gateway lives at port 3006.',
        'It proxies to gemma4 on ollama-host.',
        '',
        '## Routing',
        '',
        'Models are routed by name. Some require GPU1.',
      ].join('\n'),
    );
    await writeFile(
      path.join(tmpRoot, 'planning', 'plan.md'),
      'No matches in this file.\nJust unrelated text.\n',
    );
    await writeFile(path.join(tmpRoot, 'CLAUDE.md'), 'Workspace CLAUDE notes about the gateway feature.\n');
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('finds matches across roots with file path + line number + context', async () => {
    const tool = searchKnowledge({
      roots: [
        path.join(tmpRoot, 'knowledge'),
        path.join(tmpRoot, 'planning'),
        path.join(tmpRoot, 'CLAUDE.md'),
      ],
    });
    // Have searchKnowledge compute paths relative to the temp root.
    const prev = process.env.WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = tmpRoot;
    try {
      const out = await tool.execute({ query: 'gateway' }, makeCtx());
      expect(out).toContain('search_knowledge:');
      expect(out).toMatch(/match/);
      expect(out).toContain('knowledge/gateway.md');
      expect(out).toContain('Ollama gateway');
      expect(out).toContain('CLAUDE.md');
    } finally {
      if (prev === undefined) delete process.env.WORKSPACE_ROOT;
      else process.env.WORKSPACE_ROOT = prev;
    }
  });

  it('reports zero matches gracefully', async () => {
    const tool = searchKnowledge({ roots: [tmpRoot] });
    const out = await tool.execute({ query: 'zzzzzzz-no-such-string' }, makeCtx());
    expect(out).toMatch(/no matches/);
  });

  it('errors when query is empty', async () => {
    const tool = searchKnowledge({ roots: [tmpRoot] });
    const out = await tool.execute({ query: '' }, makeCtx());
    expect(out).toBe('search_knowledge error: query is required');
  });
});

// ─── codeReview ─────────────────────────────────────────────────

describe('codeReview', () => {
  it('returns a stub response that echoes a truncated diff', async () => {
    const tool = codeReview();
    const out = await tool.execute(
      { diff: 'diff --git a/foo b/foo\n+hello', prNumber: 7, repo: 'PeteDio-Labs/shared' },
      makeCtx(),
    );
    expect(out).toContain('code_review STUB');
    expect(out).toContain('repo=PeteDio-Labs/shared');
    expect(out).toContain('PR#7');
    expect(out).toContain('petedio-coder');
    expect(out).toContain('diff --git');
  });

  it('handles missing diff', async () => {
    const tool = codeReview();
    const out = await tool.execute({}, makeCtx());
    expect(out).toContain('(no diff provided)');
  });
});

// ─── helpers ────────────────────────────────────────────────────

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
