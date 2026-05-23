/**
 * Memory interface for the harness. Adapters call into different backends
 * (no-op, SurrealDB direct, eventual blog v2 RAG).
 *
 * Note: the original plan called for surrealMemoryClient to route through
 * memory-agent on :3013, but the audit (2026-05-22) deprecated memory-agent.
 * Adapter implementations should talk to the memory store directly OR
 * declare themselves no-op until Phase 9's blog v2 ships.
 */

export interface MemoryHit {
  id: string;
  text: string;
  similarity: number;
  sourceRef?: string;
}

export interface Fact {
  text: string;
  namespace?: string;
  tags?: string[];
}

export interface Memory {
  recall(query: string, opts?: { topK?: number; namespace?: string }): Promise<MemoryHit[]>;
  remember(fact: Fact): Promise<void>;
  forget?(id: string): Promise<void>;
}

/**
 * Default adapter — used when no memory backend is configured.
 *
 * Intentionally does NOT call `recordAgentMemoryOp()` — no-op recalls
 * shouldn't pollute the `agent_memory_ops_total` series. Real adapters
 * (SurrealDB, future blog v2 RAG) are expected to import
 * `recordAgentMemoryOp` from `@petedio/shared/agents` and call it inside
 * each of their `recall`/`remember`/`forget` implementations:
 *
 * @example
 *   import { recordAgentMemoryOp } from '@petedio/shared/agents';
 *
 *   async recall(query: string) {
 *     recordAgentMemoryOp('recall');
 *     return this.store.query(query);
 *   }
 */
export function noopMemory(): Memory {
  return {
    async recall() {
      return [];
    },
    async remember() {
      // no-op
    },
  };
}
