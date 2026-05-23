/**
 * @petedio/shared/harness — agent harness library.
 *
 * Composes the existing primitives in ../agents/ into a declarative
 * createAgent({...}) factory. Phase 3 pilots use this one-agent-per-process;
 * Phase 5 folds all agents into a single multiplexed Bun process.
 */

export { createAgent } from './createAgent.js';
export type {
  AgentMode,
  AgentRunContext,
  AgentHandle,
  CreateAgentOptions,
} from './createAgent.js';

export { LlmClient } from './llmClient.js';
export type {
  LlmClientOptions,
  ChatMessage,
  ChatRequest,
  ChatResponse,
} from './llmClient.js';

export type { Tool, ToolExecContext } from './tool.js';
export type { Memory, MemoryHit, Fact } from './memory.js';
export { noopMemory } from './memory.js';

export { startStandaloneAgentServer } from './server.js';
export type { ServerOptions, ServerHandle } from './server.js';

// Re-export the prom-client metric helpers so harness consumers don't need
// to dual-import from `@petedio/shared/agents`. These are the same handles
// `createAgent` initialises automatically at construction time; they're
// exposed here for advanced use cases (e.g. registering custom metrics
// against the same registry, manually flipping `agent_up` during graceful
// shutdown, or recording bespoke run statuses).
export {
  initAgentMetrics,
  getMetricsRegistry,
  markAgentDown,
  recordAgentRun,
  renderMetrics,
} from '../agents/metrics.js';
export type {
  AgentMetricsHandles,
  AgentRunStatus,
  InitAgentMetricsOptions,
} from '../agents/metrics.js';
