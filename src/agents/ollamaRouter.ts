const DEFAULT_OLLAMA_BASE_URL = 'http://192.168.50.59';
const DEFAULT_OLLAMA_PORT = '11434';
const DEFAULT_OLLAMA_GPU1_PORT = '11435';

// GPU0 = GTX 1660 SUPER (6 GB, SM 7.5, port 11434).
// Models that comfortably fit in 6 GB.
const GPU0_MODELS = new Set([
  'petedio-planner',
  'qwen2.5:3b',
  'gemma4:e2b',
]);

// GPU1 = RTX 3060 Ti (8 GB, SM 8.6, port 11435).
// 7B+ models, anything that needs the headroom.
// NOTE: petedio-writer + petedio-assistant promoted from GPU0 (2026-05-22)
// to fix latent OOM risk — both are FROM qwen2.5:7b.
const GPU1_MODELS = new Set([
  'gemma4:e4b',
  'petedio-coder',
  'petedio-claude-code',
  'petedio-writer',
  'petedio-assistant',
  'qwen2.5:7b',
  'qwen3:14b',
]);

// Models in GPU1_MODELS that are small enough to spill over to GPU0
// if GPU1 is unhealthy. Used by the gateway's health-aware fallback.
const SAFE_GPU0_SPILLOVER = new Set([
  'petedio-claude-code',  // FROM gemma4:e2b → fits 6 GB
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

export function isGpu0Model(model: string): boolean {
  return GPU0_MODELS.has(normalizeModelName(model));
}

export function canSpilloverToGpu0(model: string): boolean {
  return SAFE_GPU0_SPILLOVER.has(normalizeModelName(model));
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
  if (isGpu1Model(model)) return getGpu1OllamaUrl(env);
  if (isGpu0Model(model)) return getPrimaryOllamaUrl(env);
  // Unknown models default to GPU0 (safer for VRAM — small models that fit
  // anywhere will fit on 6 GB; large models will fail loudly there).
  return getPrimaryOllamaUrl(env);
}
