/**
 * @petedio/shared/harness/tools — reusable tools for harnessed agents.
 *
 * Each tool is a factory returning a `Tool<...>` (see ../tool.ts).
 * Consumers pass instances into createAgent({tools: [...]}).
 *
 * Status (2026-05-22):
 *   - webSearch        — production: hits web-search-service /api/v1/search
 *   - ragQuery         — STUB until blog v2 (Phase 9) ships
 *   - fetchUrl         — production: native fetch + HTML strip + private-host guard
 *   - searchKnowledge  — interim Phase 0-8 RAG replacement (grep workspace markdown)
 *   - codeReview       — STUB; petedio-coder wiring deferred to Phase 5+
 */

export { webSearch } from './webSearch.js';
export type { WebSearchOptions, WebSearchArgs } from './webSearch.js';

export { ragQuery } from './ragQuery.js';
export type { RagQueryOptions, RagQueryArgs } from './ragQuery.js';

export { fetchUrl } from './fetchUrl.js';
export type { FetchUrlOptions, FetchUrlArgs } from './fetchUrl.js';

export { searchKnowledge } from './searchKnowledge.js';
export type { SearchKnowledgeOptions, SearchKnowledgeArgs } from './searchKnowledge.js';

export { codeReview } from './codeReview.js';
export type { CodeReviewOptions, CodeReviewArgs } from './codeReview.js';
