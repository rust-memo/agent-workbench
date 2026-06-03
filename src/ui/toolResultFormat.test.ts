// Shell-result colorization tests. Same ESC-literal-avoidance pattern
// as the markdown tests so Biome's noControlCharactersInRegex stays happy.

import { describe, expect, it } from 'vitest';
import {
  buildToolResultView,
  colorizeShellResult,
  extractTextContent,
  looksLikeShellResult,
} from './toolResultFormat.js';

const ESC = String.fromCharCode(0x1b);
const stripAnsi = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;

describe('looksLikeShellResult', () => {
  it('recognises exit-line opener', () => {
    expect(looksLikeShellResult('exit: 0\nstdout:\nhello')).toBe(true);
    expect(looksLikeShellResult('exit: 1\nstderr:\nboom')).toBe(true);
  });

  it('recognises a bare stdout: opener (no exit)', () => {
    expect(looksLikeShellResult('stdout:\nhello')).toBe(true);
  });

  it('rejects plain prose', () => {
    expect(looksLikeShellResult('the file contains 12 lines of yaml')).toBe(false);
    expect(looksLikeShellResult('')).toBe(false);
  });
});

describe('colorizeShellResult', () => {
  it('colors exit: 0 green and dims the label', () => {
    const out = colorizeShellResult('exit: 0\nstdout:\nhello');
    expect(out).toContain(GREEN);
    expect(stripAnsi(out)).toBe('exit: 0\nstdout:\nhello');
  });

  it('colors a non-zero exit red', () => {
    const out = colorizeShellResult('exit: 3\nstdout:\nhello\nstderr:\nboom');
    expect(out).toContain(RED);
    expect(stripAnsi(out)).toContain('exit: 3');
  });

  it('colors a timeout exit yellow', () => {
    const out = colorizeShellResult('exit: timeout after 300s\nstdout:\n');
    expect(out).toContain(YELLOW);
    expect(stripAnsi(out)).toContain('exit: timeout');
  });

  it('tints stderr section red but leaves stdout alone', () => {
    const out = colorizeShellResult('exit: 1\nstdout:\nfine line\nstderr:\nbad line');
    // The stdout content "fine line" should NOT carry red ANSI.
    // The stderr content "bad line" SHOULD.
    expect(out).toContain('fine line'); // verbatim, no color wrap
    // Find the position of bad line in the styled output and ensure
    // the preceding bytes include a red opener.
    const idx = out.indexOf('bad line');
    expect(idx).toBeGreaterThan(0);
    expect(out.slice(0, idx)).toContain(RED);
  });

  it('passes blank lines + plain text inside stdout through unchanged', () => {
    const input = 'exit: 0\nstdout:\nline a\n\nline b';
    expect(stripAnsi(colorizeShellResult(input))).toBe(input);
  });

  it('empty input returns empty', () => {
    expect(colorizeShellResult('')).toBe('');
  });
});

describe('extractTextContent', () => {
  it('pulls text out of an MCP text-block array (browser snapshot shape)', () => {
    const raw = JSON.stringify([{ type: 'text', text: '- Page URL: x\n- Title: Google' }], null, 2);
    expect(extractTextContent(raw)).toBe('- Page URL: x\n- Title: Google');
  });

  it('joins multiple text blocks with newlines', () => {
    const raw = JSON.stringify([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
    expect(extractTextContent(raw)).toBe('one\ntwo');
  });

  it('leaves non-text content (e.g. an image block) as raw JSON', () => {
    const raw = JSON.stringify([{ type: 'image', data: 'base64...' }]);
    expect(extractTextContent(raw)).toBe(raw);
  });

  it('passes plain (non-JSON) strings through unchanged', () => {
    expect(extractTextContent('exit: 0\nstdout:\nhi')).toBe('exit: 0\nstdout:\nhi');
  });
});

describe('buildToolResultView', () => {
  it('compacts successful shell stdout to the meaningful output', () => {
    const v = buildToolResultView('exit: 0\nstdout:\n404 ftp.gobus.net');
    expect(v.collapsible).toBe(false);
    expect(stripAnsi(v.preview)).toBe('404 ftp.gobus.net');
  });

  it('removes exit/stdout wrappers from multiline successful shell output', () => {
    const html = [
      '<!DOCTYPE html>',
      '<html lang="ar" dir="rtl">',
      '<head>',
      '  <meta charset="UTF-8" />',
    ].join('\n');
    const v = buildToolResultView(`exit: 0\r\nstdout:\r\n${html}`);
    const plain = stripAnsi(v.preview);
    expect(plain).toBe(html);
    expect(plain).not.toContain('exit: 0');
    expect(plain).not.toContain('stdout:');
  });

  it('keeps shell structure when exit is non-zero or stderr exists', () => {
    const failed = buildToolResultView('exit: 1\nstdout:\nnope');
    expect(stripAnsi(failed.preview)).toContain('exit: 1');
    expect(stripAnsi(failed.preview)).toContain('stdout:\nnope');

    const warned = buildToolResultView('exit: 0\nstdout:\nok\nstderr:\nwarning');
    expect(stripAnsi(warned.preview)).toContain('exit: 0');
    expect(stripAnsi(warned.preview)).toContain('stderr:\nwarning');
  });

  it('renders empty non-zero shell output as no output instead of a blank stdout block', () => {
    const v = buildToolResultView('exit: 1\nstdout:\n');
    expect(stripAnsi(v.preview)).toBe('exit: 1\n(no output)');
  });

  it('omits empty stdout when a non-zero shell result only has stderr', () => {
    const v = buildToolResultView(
      [
        'exit: 2',
        'stdout:',
        'stderr:',
        "/bin/bash: -c: line 0: unexpected EOF while looking for matching `''",
        '/bin/bash: -c: line 1: syntax error: unexpected end of file',
      ].join('\n'),
    );
    const plain = stripAnsi(v.preview);
    expect(plain).toContain('exit: 2\nstderr:\n/bin/bash');
    expect(plain).not.toContain('stdout:');
  });

  it('does not collapse short output', () => {
    const v = buildToolResultView('a\nb\nc');
    expect(v.collapsible).toBe(false);
    expect(v.preview).toBe(v.full);
  });

  it('collapses long output to a head preview with an expand notice', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const v = buildToolResultView(body);
    expect(v.collapsible).toBe(true);
    const previewLines = stripAnsi(v.preview).split('\n');
    // 12 head lines + 1 notice line.
    expect(previewLines.length).toBeLessThanOrEqual(13);
    expect(stripAnsi(v.preview)).toContain('more lines');
    expect(stripAnsi(v.preview)).toContain('Ctrl-O to expand');
    // Full view keeps everything.
    expect(stripAnsi(v.full)).toContain('line 199');
  });

  it('collapses a giant single line by char cap', () => {
    const v = buildToolResultView('x'.repeat(5000));
    expect(v.collapsible).toBe(true);
    expect(stripAnsi(v.preview).length).toBeLessThan(1100);
    expect(stripAnsi(v.preview)).toContain('Ctrl-O to expand');
  });

  it('extracts MCP text then collapses it (browser snapshot end-to-end)', () => {
    const snapshot = Array.from({ length: 100 }, (_, i) => `  link "item ${i}"`).join('\n');
    const raw = JSON.stringify([{ type: 'text', text: snapshot }]);
    const v = buildToolResultView(raw);
    expect(v.collapsible).toBe(true);
    // No JSON envelope leaks into the rendered preview.
    expect(stripAnsi(v.preview)).not.toContain('"type"');
    expect(stripAnsi(v.preview)).toContain('link "item 0"');
  });
});
