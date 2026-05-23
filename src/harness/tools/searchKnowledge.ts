/**
 * searchKnowledge — interim repo-grep tool that stands in for the
 * Phase 9 blog v2 RAG index.
 *
 * Behaviour: case-insensitive substring grep over markdown/text files
 * under the configured roots. Returns up to N matches with ~5 lines of
 * surrounding context, file path (relative to WORKSPACE_ROOT), and the
 * matching line number.
 *
 * Defaults:
 *   roots = [
 *     ${WORKSPACE_ROOT}/knowledge/,
 *     ${WORKSPACE_ROOT}/planning/,
 *     ${WORKSPACE_ROOT}/CLAUDE.md,
 *     ${WORKSPACE_ROOT}/MEMORY.md,
 *     ${WORKSPACE_ROOT}/.claude/CLAUDE.md,
 *     ${WORKSPACE_ROOT}/.claude/memory/MEMORY.md,
 *     ${WORKSPACE_ROOT}/infrastructure/ansible/playbooks/(**)/README.md,
 *   ]
 *   maxResults        = 5
 *   maxBytesPerResult = 2000
 *
 * Skips files larger than 1 MB (minified assets, generated reports).
 * Honours ctx.signal — aborts the walk between files and lines.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '../tool.js';

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_BYTES = 2000;
const MAX_FILE_SIZE_BYTES = 1_000_000;
const CONTEXT_LINES = 5;
const FILE_EXT_REGEX = /\.(md|markdown|txt)$/i;
const WALK_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.terraform',
  '.cache',
  'coverage',
]);

export interface SearchKnowledgeOptions {
  /** Absolute roots — files OR directories. Globs are NOT supported; the
   *  walker recurses into directories itself. Defaults derived from
   *  `WORKSPACE_ROOT` env var (or `/home/pedro/PeteDio-Labs`). */
  roots?: string[];
  maxResults?: number;
  maxBytesPerResult?: number;
}

export interface SearchKnowledgeArgs {
  query: string;
}

interface Hit {
  filePath: string;
  relPath: string;
  lineNumber: number;
  context: string;
}

export function searchKnowledge(opts: SearchKnowledgeOptions = {}): Tool<SearchKnowledgeArgs> {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? '/home/pedro/PeteDio-Labs';
  const roots = (opts.roots && opts.roots.length > 0 ? opts.roots : defaultRoots(workspaceRoot)).map(
    (r) => path.resolve(r),
  );
  const maxResults = Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS);
  const maxBytesPerResult = Math.max(200, opts.maxBytesPerResult ?? DEFAULT_MAX_BYTES);

  return {
    name: 'search_knowledge',
    description:
      'Search the local PeteDio-Labs workspace (knowledge/, planning/, CLAUDE.md, MEMORY.md, playbook READMEs) for a substring. Case-insensitive. Returns up to ~5 hits with surrounding context, file path, line number. INTERIM stand-in for the blog v2 RAG index.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to search for. Case-insensitive.' },
      },
      required: ['query'],
    },
    async execute(args, ctx) {
      const query = (args?.query ?? '').toString().trim();
      if (!query) return 'search_knowledge error: query is required';

      const signal = ctx.signal ?? new AbortController().signal;

      try {
        const needle = query.toLowerCase();
        const hits: Hit[] = [];

        for (const root of roots) {
          if (signal.aborted) break;
          if (hits.length >= maxResults) break;
          await walkAndScan(root, workspaceRoot, needle, hits, maxResults, maxBytesPerResult, signal);
        }

        if (hits.length === 0) {
          return `search_knowledge: no matches for "${query}" across ${roots.length} root(s).`;
        }

        const lines = [`search_knowledge: ${hits.length} match(es) for "${query}":`];
        for (let i = 0; i < hits.length; i++) {
          const h = hits[i]!;
          lines.push('');
          lines.push(`${i + 1}. ${h.relPath}:${h.lineNumber}`);
          lines.push('   ---');
          for (const line of h.context.split('\n')) {
            lines.push(`   ${line}`);
          }
          lines.push('   ---');
        }
        return lines.join('\n');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log?.warn({ err: msg }, 'search_knowledge: walk failed');
        return `search_knowledge error: ${msg}`;
      }
    },
  };
}

function defaultRoots(workspaceRoot: string): string[] {
  return [
    path.join(workspaceRoot, 'knowledge'),
    path.join(workspaceRoot, 'planning'),
    path.join(workspaceRoot, 'CLAUDE.md'),
    path.join(workspaceRoot, 'MEMORY.md'),
    path.join(workspaceRoot, '.claude', 'CLAUDE.md'),
    path.join(workspaceRoot, '.claude', 'memory', 'MEMORY.md'),
    path.join(workspaceRoot, 'infrastructure', 'ansible', 'playbooks'),
  ];
}

async function walkAndScan(
  target: string,
  workspaceRoot: string,
  needle: string,
  hits: Hit[],
  maxResults: number,
  maxBytesPerResult: number,
  signal: AbortSignal,
): Promise<void> {
  if (hits.length >= maxResults || signal.aborted) return;

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(target);
  } catch {
    return; // root may not exist on this host; skip silently
  }

  if (stat.isFile()) {
    if (target.endsWith('/README.md') || FILE_EXT_REGEX.test(target)) {
      await scanFile(target, workspaceRoot, needle, hits, maxResults, maxBytesPerResult, stat.size);
    }
    return;
  }

  if (!stat.isDirectory()) return;

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return;
  }

  // Sort for deterministic ordering.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (hits.length >= maxResults || signal.aborted) return;
    if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
    if (WALK_IGNORE.has(entry.name)) continue;

    const childPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await walkAndScan(childPath, workspaceRoot, needle, hits, maxResults, maxBytesPerResult, signal);
    } else if (entry.isFile() && (FILE_EXT_REGEX.test(entry.name) || entry.name === 'README.md')) {
      let size = 0;
      try {
        size = (await fs.stat(childPath)).size;
      } catch {
        continue;
      }
      await scanFile(childPath, workspaceRoot, needle, hits, maxResults, maxBytesPerResult, size);
    }
  }
}

async function scanFile(
  filePath: string,
  workspaceRoot: string,
  needle: string,
  hits: Hit[],
  maxResults: number,
  maxBytesPerResult: number,
  fileSize: number,
): Promise<void> {
  if (fileSize > MAX_FILE_SIZE_BYTES) return;
  if (hits.length >= maxResults) return;

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return;
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (hits.length >= maxResults) return;
    const line = lines[i] ?? '';
    if (line.toLowerCase().includes(needle)) {
      const start = Math.max(0, i - CONTEXT_LINES);
      const end = Math.min(lines.length, i + CONTEXT_LINES + 1);
      let context = lines.slice(start, end).join('\n');
      if (context.length > maxBytesPerResult) {
        context = context.slice(0, maxBytesPerResult) + '\n[...truncated]';
      }
      const relPath = path.relative(workspaceRoot, filePath) || filePath;
      hits.push({ filePath, relPath, lineNumber: i + 1, context });
      // Skip ahead so we don't emit overlapping context blocks for the same hit cluster.
      i = end;
    }
  }
}
