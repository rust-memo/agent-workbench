import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerScannerRunner, RAW_SCANNER_IMAGE, SAFE_SCANNER_IMAGE } from './dockerRunner.js';
import { clean } from './localRunner.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('scanner output sanitation', () => {
  it('removes ANSI, OSC, control and null-byte output', () => {
    const malicious = '\u001b]0;owned\u0007safe\u001b[31m red\u001b[0m\u0000';
    expect(clean(malicious)).toBe('safe red');
  });
});

describe('Docker scanner boundary', () => {
  it('uses fixed hardening, no mounts, and sends targets through stdin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-workbench-docker-test-'));
    roots.push(root);
    const log = join(root, 'calls.jsonl');
    const fakeDocker = join(root, 'docker');
    await writeFile(
      fakeDocker,
      [
        `#!${process.execPath}`,
        "const fs = require('fs');",
        `const log = ${JSON.stringify(log)};`,
        'const args = process.argv.slice(2);',
        "if (args[0] !== 'run') { fs.appendFileSync(log, JSON.stringify({ args, input: '' }) + '\\n'); process.exit(0); }",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  fs.appendFileSync(log, JSON.stringify({ args, input }) + '\\n');",
        "  if (process.argv.includes('run')) process.stdout.write('{}\\n');",
        '});',
        'process.stdin.resume();',
      ].join('\n'),
      { mode: 0o700 },
    );
    const runner = new DockerScannerRunner(SAFE_SCANNER_IMAGE, fakeDocker, RAW_SCANNER_IMAGE, true);
    const target = 'example.com;touch /tmp/owned';
    const result = await runner.dnsx(
      [target],
      {
        requestsPerSecond: 5,
        concurrency: 4,
        maxUrlsPerHost: 100,
        maxRedirects: 0,
        maxRuntimeSeconds: 30,
        maxOutputBytes: 1024 * 1024,
      },
      new AbortController().signal,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; input: string });
    const run = calls.find((call) => call.args[0] === 'run');
    expect(run?.input).toBe(`${target}\n`);
    expect(run?.args).not.toContain(target);
    expect(run?.args).toContain('--read-only');
    expect(run?.args).toContain('no-new-privileges:true');
    expect(run?.args).toContain('ALL');
    expect(run?.args).not.toContain('--privileged');
    expect(run?.args).not.toContain('--volume');
    expect(run?.args.join(' ')).not.toContain('docker.sock');
    expect(run?.args).toContain(SAFE_SCANNER_IMAGE);

    await runner.ffuf(
      'https://example.com/base',
      { matchCodes: [200, 403] },
      {
        requestsPerSecond: 5,
        concurrency: 4,
        maxUrlsPerHost: 100,
        maxRedirects: 0,
        maxRuntimeSeconds: 30,
        maxOutputBytes: 1024 * 1024,
      },
      new AbortController().signal,
    );
    await runner.nmap(
      ['example.com'],
      { ports: [80, 443], raw: true },
      {
        requestsPerSecond: 5,
        concurrency: 4,
        maxUrlsPerHost: 100,
        maxRedirects: 0,
        maxRuntimeSeconds: 30,
        maxOutputBytes: 1024 * 1024,
      },
      new AbortController().signal,
    );
    const allCalls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; input: string });
    const ffuf = allCalls.find((call) => call.args.includes('ffuf'));
    expect(ffuf?.args).toContain('/opt/wordlists/common.txt');
    expect(ffuf?.args).toContain('https://example.com/base/FUZZ');
    const raw = allCalls.find((call) => call.args.includes(RAW_SCANNER_IMAGE));
    expect(raw?.args).toContain('NET_RAW');
    expect(raw?.args).toContain('-sS');
    expect(raw?.args).not.toContain('--privileged');
  });

  it('fails closed when the raw-socket profile is not explicitly enabled', async () => {
    const runner = new DockerScannerRunner('safe', 'docker', 'raw', false);
    await expect(
      runner.nmap(
        ['example.com'],
        { ports: [80], raw: true },
        {
          requestsPerSecond: 5,
          concurrency: 4,
          maxUrlsPerHost: 100,
          maxRedirects: 0,
          maxRuntimeSeconds: 30,
          maxOutputBytes: 1024 * 1024,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('raw-socket scanner profile is disabled');
  });

  it('returns sanitized partial output from a non-zero Docker scanner exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-workbench-docker-partial-'));
    roots.push(root);
    const fakeDocker = join(root, 'docker');
    await writeFile(
      fakeDocker,
      [
        `#!${process.execPath}`,
        "if (process.argv[2] !== 'run') process.exit(0);",
        'process.stdin.resume();',
        "process.stdin.on('end', () => {",
        "  process.stdout.write('api.example.com\\n');",
        "  process.stderr.write('\\u001b[31mpartial provider failure\\u001b[0m');",
        '  process.exit(2);',
        '});',
      ].join('\n'),
      { mode: 0o700 },
    );
    const runner = new DockerScannerRunner(SAFE_SCANNER_IMAGE, fakeDocker);
    const result = await runner.subfinder(
      'example.com',
      {
        requestsPerSecond: 5,
        concurrency: 4,
        maxUrlsPerHost: 100,
        maxRedirects: 0,
        maxRuntimeSeconds: 30,
        maxOutputBytes: 1024 * 1024,
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      stdout: 'api.example.com',
      stderr: 'partial provider failure',
      exitCode: 2,
      termination: 'exit',
    });
  });
});
