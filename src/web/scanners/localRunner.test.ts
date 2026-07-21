import { describe, expect, it } from 'vitest';
import { clean } from './localRunner.js';

describe('scanner output sanitation', () => {
  it('removes ANSI, OSC, control and null-byte output', () => {
    const malicious = '\u001b]0;owned\u0007safe\u001b[31m red\u001b[0m\u0000';
    expect(clean(malicious)).toBe('safe red');
  });
});
