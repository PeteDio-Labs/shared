const DEFAULT_OLLAMA_BASE_URL = 'http://192.168.50.59';
const DEFAULT_OLLAMA_PORT = '11434';
const DEFAULT_OLLAMA_GPU1_PORT = '11435';

const GPU1_MODELS = new Set([
  'gemma4:e4b',
  'petedio-coder',
  'petedio-claude-code',
  'qwen3:14b',
]);

type OllamaEnv = Record<string, string | undefined>;

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase().replace(/:latest$/, '');
}

function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');

  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return trimmed.replace(/:\d+$/, '');
  }
}

function buildUrl(baseUrl: string, port: string): string {
  return `${baseUrl}:${port}`;
}

export function isGpu1Model(model: string): boolean {
  return GPU1_MODELS.has(normalizeModelName(model));
}

export function getOllamaBaseUrl(env: OllamaEnv = process.env): string {
  return normalizeBaseUrl(
    env.OLLAMA_BASE_URL
      ?? env.OLLAMA_URL
      ?? `${DEFAULT_OLLAMA_BASE_URL}:${DEFAULT_OLLAMA_PORT}`,
  );
}

export function getPrimaryOllamaUrl(env: OllamaEnv = process.env): string {
  return env.OLLAMA_URL ?? buildUrl(getOllamaBaseUrl(env), DEFAULT_OLLAMA_PORT);
}

export function getGpu1OllamaUrl(env: OllamaEnv = process.env): string {
  return env.OLLAMA_URL_GPU1 ?? buildUrl(getOllamaBaseUrl(env), DEFAULT_OLLAMA_GPU1_PORT);
}

export function resolveOllamaUrl(model: string, env: OllamaEnv = process.env): string {
  return isGpu1Model(model) ? getGpu1OllamaUrl(env) : getPrimaryOllamaUrl(env);
}
