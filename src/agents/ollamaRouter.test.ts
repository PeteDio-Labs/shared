/**
 * Tests for the GPU-asymmetry routing refactor (plan Phase 1, 2026-05-22).
 * Validates that:
 *  - heavy 7B+ models route to GPU1 (port 11435)
 *  - light models route to GPU0 (port 11434)
 *  - unknown models default to GPU0 (safer for VRAM)
 *  - spillover allow-list is enforced
 */

import { describe, expect, it } from 'vitest';
import {
  canSpilloverToGpu0,
  getGpu1OllamaUrl,
  getPrimaryOllamaUrl,
  isGpu0Model,
  isGpu1Model,
  resolveOllamaUrl,
} from './ollamaRouter.js';

const ENV = {
  OLLAMA_BASE_URL: 'http://test-host',
  OLLAMA_URL: 'http://test-host:11434',
  OLLAMA_URL_GPU1: 'http://test-host:11435',
} as const;

describe('ollamaRouter — GPU asymmetry split', () => {
  it('routes 7B+ custom models to GPU1', () => {
    expect(resolveOllamaUrl('petedio-writer', ENV)).toBe('http://test-host:11435');
    expect(resolveOllamaUrl('petedio-coder', ENV)).toBe('http://test-host:11435');
    expect(resolveOllamaUrl('petedio-assistant', ENV)).toBe('http://test-host:11435');
    expect(resolveOllamaUrl('petedio-claude-code', ENV)).toBe('http://test-host:11435');
  });

  it('routes large base models to GPU1', () => {
    expect(resolveOllamaUrl('qwen2.5:7b', ENV)).toBe('http://test-host:11435');
    expect(resolveOllamaUrl('qwen3:14b', ENV)).toBe('http://test-host:11435');
    expect(resolveOllamaUrl('gemma4:e4b', ENV)).toBe('http://test-host:11435');
  });

  it('routes lightweight models to GPU0', () => {
    expect(resolveOllamaUrl('petedio-planner', ENV)).toBe('http://test-host:11434');
    expect(resolveOllamaUrl('qwen2.5:3b', ENV)).toBe('http://test-host:11434');
    expect(resolveOllamaUrl('gemma4:e2b', ENV)).toBe('http://test-host:11434');
  });

  it('defaults unknown models to GPU0', () => {
    expect(resolveOllamaUrl('mystery-model:42b', ENV)).toBe('http://test-host:11434');
  });

  it('normalizes :latest suffix and case', () => {
    expect(resolveOllamaUrl('PETEDIO-WRITER:LATEST', ENV)).toBe('http://test-host:11435');
    expect(resolveOllamaUrl('qwen2.5:7B', ENV)).toBe('http://test-host:11435');
  });

  it('isGpu0Model + isGpu1Model are mutually exclusive', () => {
    const samples = [
      'petedio-planner', 'petedio-writer', 'petedio-coder',
      'qwen2.5:3b', 'qwen2.5:7b', 'qwen3:14b',
      'gemma4:e2b', 'gemma4:e4b',
    ];
    for (const m of samples) {
      expect(isGpu0Model(m) && isGpu1Model(m)).toBe(false);
    }
  });

  it('spillover allow-list permits petedio-claude-code only', () => {
    expect(canSpilloverToGpu0('petedio-claude-code')).toBe(true);
    expect(canSpilloverToGpu0('qwen3:14b')).toBe(false);
    expect(canSpilloverToGpu0('petedio-coder')).toBe(false);
    expect(canSpilloverToGpu0('petedio-writer')).toBe(false);
  });

  it('getPrimaryOllamaUrl + getGpu1OllamaUrl honor env overrides', () => {
    expect(getPrimaryOllamaUrl(ENV)).toBe('http://test-host:11434');
    expect(getGpu1OllamaUrl(ENV)).toBe('http://test-host:11435');
  });
});
