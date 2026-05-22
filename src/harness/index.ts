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
