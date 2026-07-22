import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import type { ScannerLimits } from '../types.js';
import { clean } from './output.js';

export const SAFE_SCANNER_IMAGE = 'agent-workbench-scanner-safe:0.3.0';

export type ScannerName = 'subfinder' | 'dnsx' | 'httpx' | 'katana' | 'nuclei';

export interface ScannerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ScannerHealth {
  available: boolean;
  detail: string;
  isolation: 'docker';
  image: string;
}

/**
 * Ephemeral, server-owned Docker scanner boundary. No API/model-controlled image,
 * entrypoint, mount, environment, network mode, capability, working directory,
 * or raw command is accepted here.
 */
export class DockerScannerRunner {
  constructor(
    private readonly image = SAFE_SCANNER_IMAGE,
    private readonly dockerBinary = 'docker',
  ) {}

  async subfinder(
    domain: string,
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    return this.run(
      'subfinder',
      ['-silent', '-duc', '-d', domain, '-timeout', '30', '-max-time', '5'],
      undefined,
      limits,
      signal,
    );
  }

  async dnsx(
    targets: string[],
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    return this.run(
      'dnsx',
      [
        '-silent',
        '-duc',
        '-json',
        '-omit-raw',
        '-no-color',
        '-threads',
        String(limits.concurrency),
        '-rate-limit',
        String(limits.requestsPerSecond),
        '-retry',
        '1',
        '-timeout',
        '3s',
      ],
      lines(targets),
      limits,
      signal,
    );
  }

  async httpx(
    targets: string[],
    options: { requestsPerSecond: number; concurrency: number; followRedirects: false },
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    return this.run(
      'httpx',
      [
        '-silent',
        '-duc',
        '-json',
        '-status-code',
        '-title',
        '-tech-detect',
        '-no-color',
        '-threads',
        String(options.concurrency),
        '-rate-limit',
        String(options.requestsPerSecond),
        '-timeout',
        '10',
        '-no-fallback',
        '-no-fallback-scheme',
      ],
      lines(targets),
      limits,
      signal,
    );
  }

  async katana(
    targets: string[],
    options: { depth: number },
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    return this.run(
      'katana',
      [
        '-silent',
        '-duc',
        '-jsonl',
        '-no-color',
        '-omit-raw',
        '-omit-body',
        '-disable-redirects',
        '-field-scope',
        'fqdn',
        '-depth',
        String(options.depth),
        '-max-domain-pages',
        String(limits.maxUrlsPerHost),
        '-concurrency',
        String(limits.concurrency),
        '-parallelism',
        '1',
        '-rate-limit',
        String(limits.requestsPerSecond),
        '-timeout',
        '10',
        '-crawl-duration',
        `${limits.maxRuntimeSeconds}s`,
      ],
      lines(targets),
      limits,
      signal,
    );
  }

  async nuclei(
    targets: string[],
    options: { severities: Array<'info' | 'low' | 'medium' | 'high' | 'critical'> },
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    return this.run(
      'nuclei',
      [
        '-silent',
        '-duc',
        '-auth=false',
        '-jsonl',
        '-no-color',
        '-omit-raw',
        '-omit-template',
        '-disable-unsigned-templates',
        '-disable-redirects',
        '-no-interactsh',
        '-restrict-local-network-access',
        '-type',
        'http',
        '-templates',
        '/opt/nuclei-templates/http',
        '-exclude-tags',
        'dos,fuzz,intrusive,bruteforce,default-login',
        '-severity',
        options.severities.join(','),
        '-rate-limit',
        String(limits.requestsPerSecond),
        '-concurrency',
        String(Math.min(limits.concurrency, 10)),
        '-bulk-size',
        String(Math.min(limits.concurrency, 10)),
        '-timeout',
        '10',
        '-retries',
        '0',
      ],
      lines(targets),
      limits,
      signal,
    );
  }

  async health(): Promise<Record<ScannerName, ScannerHealth>> {
    let available = false;
    let detail = `Docker image ${this.image} is not built. Run: npm run scanner:build`;
    try {
      const result = await execa(this.dockerBinary, ['image', 'inspect', this.image], {
        reject: false,
        timeout: 5000,
        extendEnv: false,
        env: dockerEnvironment(),
      });
      available = result.exitCode === 0;
      if (available) detail = `${this.image} ready`;
      else if (result.stderr) detail = clean(result.stderr).slice(0, 300);
    } catch (error) {
      detail = `Docker unavailable: ${safeMessage(error)}`;
    }
    return Object.fromEntries(
      (['subfinder', 'dnsx', 'httpx', 'katana', 'nuclei'] as const).map((name) => [
        name,
        { available, detail, isolation: 'docker' as const, image: this.image },
      ]),
    ) as Record<ScannerName, ScannerHealth>;
  }

  private async run(
    scanner: ScannerName,
    scannerArgs: string[],
    input: string | undefined,
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    const containerName = `agent-workbench-scan-${randomUUID()}`;
    const args = [
      'run',
      '--rm',
      '--name',
      containerName,
      '--read-only',
      '--user',
      '65532:65532',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '256',
      '--memory',
      '768m',
      '--cpus',
      '1',
      '--network',
      'bridge',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=128m,uid=65532,gid=65532',
      '--env',
      'HOME=/tmp/home',
      '--env',
      'XDG_CACHE_HOME=/tmp/cache',
      '--env',
      'XDG_CONFIG_HOME=/tmp/config',
      '--label',
      'io.agent-workbench.role=scanner-safe',
      '-i',
      this.image,
      scanner,
      ...scannerArgs,
    ];
    try {
      const result = await execa(this.dockerBinary, args, {
        input,
        cancelSignal: signal,
        reject: false,
        timeout: limits.maxRuntimeSeconds * 1000,
        maxBuffer: limits.maxOutputBytes,
        extendEnv: false,
        env: dockerEnvironment(),
      });
      return {
        stdout: clean(result.stdout),
        stderr: clean(result.stderr),
        exitCode: result.exitCode ?? 1,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(
        `${scanner} container failed to start or exceeded its limits: ${safeMessage(error)}`,
      );
    } finally {
      await execa(this.dockerBinary, ['rm', '-f', containerName], {
        reject: false,
        timeout: 5000,
        extendEnv: false,
        env: dockerEnvironment(),
      }).catch(() => undefined);
    }
  }
}

function lines(values: string[]): string {
  return `${values.join('\n')}\n`;
}

function dockerEnvironment(): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
}

function safeMessage(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error)).slice(0, 500);
}
