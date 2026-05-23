/**
 * codeReview — STUB.
 *
 * The original code-review-agent on port 3012 was shelved per the
 * 2026-05-22 audit. This tool keeps a slot warm so harnessed agents can
 * register and call it; today it returns a structured "not wired"
 * response that echoes back a (truncated) diff so the LLM can at least
 * reason about what would have been reviewed.
 *
 * TODO(Phase 5+): wire petedio-coder via LlmClient from ../llmClient
 * when the code-review surface is brought back. Keep the same factory
 * signature so consumers don't have to refactor.
 */
import type { Tool, ToolExecContext } from '../tool.js';

const DEFAULT_MODEL = 'petedio-coder';
const DEFAULT_OLLAMA_URL = 'http://192.168.50.59:11434';
const MAX_DIFF_PREVIEW_BYTES = 4_000;

export interface CodeReviewOptions {
  /** Ollama model to invoke when wiring is complete. Default: petedio-coder. */
  model?: string;
  /** Ollama URL. Default: http://192.168.50.59:11434 (ollama-host RTX 3060 Ti). */
  ollamaUrl?: string;
}

export interface CodeReviewArgs {
  /** Unified diff text to review. */
  diff?: string;
  /** Optional GitHub PR number for context. */
  prNumber?: number;
  /** Optional `owner/repo` slug for context. */
  repo?: string;
}

export function codeReview(opts: CodeReviewOptions = {}): Tool<CodeReviewArgs> {
  const model = opts.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
  const ollamaUrl = opts.ollamaUrl ?? process.env.OLLAMA_URL_GPU1 ?? DEFAULT_OLLAMA_URL;

  return {
    name: 'code_review',
    description:
      'Run a code review on a unified diff using petedio-coder. STUB — currently returns a structured "not wired" response. Use for PR review, refactor critique, security flags.',
    parameters: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'Unified diff text to review.' },
        prNumber: { type: 'number', description: 'GitHub PR number (optional context).' },
        repo: { type: 'string', description: 'GitHub repo slug owner/repo (optional context).' },
      },
      required: [],
    },
    async execute(args, ctx: ToolExecContext) {
      const diff = (args?.diff ?? '').toString();
      const repo = args?.repo ? ` repo=${args.repo}` : '';
      const pr = typeof args?.prNumber === 'number' ? ` PR#${args.prNumber}` : '';

      ctx.log?.info(
        { repo: args?.repo, prNumber: args?.prNumber, diffBytes: diff.length, model, ollamaUrl },
        'code_review: stub invoked',
      );

      const preview = diff
        ? diff.length > MAX_DIFF_PREVIEW_BYTES
          ? diff.slice(0, MAX_DIFF_PREVIEW_BYTES) + '\n[...diff truncated]'
          : diff
        : '(no diff provided)';

      return [
        `code_review STUB${repo}${pr}.`,
        `Would invoke model="${model}" at ${ollamaUrl} on the diff below.`,
        'Implementation pending — see TODO(Phase 5+) in tools/codeReview.ts.',
        '',
        '--- diff (echo) ---',
        preview,
      ].join('\n');
    },
  };
}
