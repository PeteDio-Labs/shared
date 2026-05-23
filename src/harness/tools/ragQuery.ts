/**
 * ragQuery — placeholder for the internal RAG index.
 *
 * The real backend is the blog v2 RAG service shipping in Phase 9. Until
 * then this tool returns a STRUCTURED stub so the LLM understands the
 * capability exists, knows what it asked, and knows the fallback path
 * (use searchKnowledge() against the workspace markdown).
 *
 * TODO(Phase 9): replace the stub body with a fetch to the blog v2 RAG
 * endpoint once it ships. Keep the same factory signature so consumers
 * don't have to refactor.
 */
import type { Tool, ToolExecContext } from '../tool.js';

export interface RagQueryOptions {
  /**
   * Phase 9 hook: future blog v2 RAG endpoint. Currently ignored — the
   * tool always returns the stub message. Wiring this through now lets
   * consumers configure the URL ahead of the Phase 9 swap.
   */
  apiUrl?: string;
}

export interface RagQueryArgs {
  question: string;
  topK?: number;
}

export function ragQuery(_opts: RagQueryOptions = {}): Tool<RagQueryArgs> {
  return {
    name: 'rag_query',
    description:
      'Query the internal RAG index (blog v2). NOT YET AVAILABLE — returns a structured 503-style stub. Use search_knowledge to grep the workspace markdown as a fallback.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural-language question to ask the RAG index.' },
        topK: { type: 'number', description: 'Max number of source passages to return. Default 5.' },
      },
      required: ['question'],
    },
    async execute(args, ctx: ToolExecContext) {
      const question = (args?.question ?? '').toString().trim();
      if (!question) return 'rag_query error: question is required';

      ctx.log?.info({ question }, 'rag_query: stub — blog v2 (Phase 9) not yet shipped');

      return [
        'RAG unavailable — blog v2 (Phase 9) not yet shipped.',
        `Hint: I would have searched the internal RAG index for: "${question}".`,
        'Fallback: use search_knowledge() against repo markdown instead.',
      ].join('\n');
    },
  };
}
