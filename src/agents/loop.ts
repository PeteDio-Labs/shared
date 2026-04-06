/**
 * Gemma 4 tool-calling loop.
 * Uses Ollama /api/chat with tool definitions.
 * Runs until the model stops calling tools or max iterations is reached.
 */

const MAX_ITERATIONS = 10;

// ─── Ollama Chat Types ────────────────────────────────────────────

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required?: string[];
    };
  };
}

interface OllamaChatResponse {
  message: OllamaMessage;
  done: boolean;
}

// ─── Public API ───────────────────────────────────────────────────

export interface ToolDef<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: OllamaToolDef['function']['parameters'];
  execute: (args: TArgs) => Promise<string>;
}

export interface LoopOptions {
  ollamaUrl: string;
  model: string;
  system: string;
  userPrompt: string;
  tools: ToolDef[];
  maxIterations?: number;
  onIteration?: (iteration: number, content: string) => void;
}

export interface LoopResult {
  finalResponse: string;
  iterations: number;
  toolCallLog: { tool: string; args: Record<string, unknown>; result: string }[];
}

export async function runToolLoop(opts: LoopOptions): Promise<LoopResult> {
  const {
    ollamaUrl,
    model,
    system,
    userPrompt,
    tools,
    maxIterations = MAX_ITERATIONS,
    onIteration,
  } = opts;

  const toolIndex = new Map(tools.map(t => [t.name, t]));
  const ollamTools: OllamaToolDef[] = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const messages: OllamaMessage[] = [
    { role: 'user', content: userPrompt },
  ];

  const toolCallLog: LoopResult['toolCallLog'] = [];
  let finalResponse = '';
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, system, messages, tools: ollamTools, stream: false }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      throw new Error(`Ollama chat error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as OllamaChatResponse;
    const assistantMsg = data.message;
    messages.push(assistantMsg);

    const content = assistantMsg.content ?? '';
    if (content) {
      finalResponse = content;
      onIteration?.(iterations, content);
    }

    // No tool calls → done
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      break;
    }

    // Execute each tool call
    for (const call of assistantMsg.tool_calls) {
      const { name, arguments: args } = call.function;
      const tool = toolIndex.get(name);

      let result: string;
      if (!tool) {
        result = `Error: unknown tool "${name}"`;
      } else {
        try {
          result = await tool.execute(args as never);
        } catch (err) {
          result = `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      toolCallLog.push({ tool: name, args, result });

      // Add tool result as a message
      messages.push({ role: 'tool', content: result });
    }
  }

  return { finalResponse, iterations, toolCallLog };
}
