import { describe, expect, it } from 'vitest';
import { inferModelBillions, modelReliabilityWarning } from './modelWarnings.js';

describe('inferModelBillions', () => {
  it('parses common local model size suffixes', () => {
    expect(inferModelBillions('qwen2.5-coder:7b-instruct-q4_K_M')).toBe(7);
    expect(inferModelBillions('qwen2.5-coder:14b-instruct-q4_K_M')).toBe(14);
    expect(inferModelBillions('llama-3.1-8b')).toBe(8);
    expect(inferModelBillions('mixtral-8x7b')).toBe(7);
  });

  it('returns undefined when no model size is encoded', () => {
    expect(inferModelBillions('gpt-4.1-mini')).toBeUndefined();
  });
});

describe('modelReliabilityWarning', () => {
  it('warns for sub-14b local models', () => {
    expect(modelReliabilityWarning('ollama', 'qwen2.5-coder:7b')).toContain(
      'Recommended minimum: 14b locally',
    );
  });

  it('does not warn for 14b local models', () => {
    expect(modelReliabilityWarning('ollama', 'qwen2.5-coder:14b')).toBeUndefined();
  });

  it('warns differently for small openai-compatible hosted models', () => {
    expect(modelReliabilityWarning('openai-compat', 'llama-3.1-8b')).toContain('70b+');
  });

  it('treats Kimi as a hosted provider for size warnings', () => {
    expect(modelReliabilityWarning('kimi', 'llama-3.1-8b')).toContain('70b+');
  });
});
