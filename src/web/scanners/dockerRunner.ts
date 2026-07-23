import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import type { ScannerLimits } from '../types.js';
import { clean } from './output.js';

export const SAFE_SCANNER_IMAGE = 'agent-workbench-scanner-safe:0.5.0';
export const RAW_SCANNER_IMAGE = 'agent-workbench-scanner-raw:0.5.0';

export type ScannerName =
  | 'subfinder'
  | 'dnsx'
  | 'httpx'
  | 'katana'
  | 'nuclei'
  | 'ffuf'
  | 'nmap_connect'
  | 'nmap_raw'
  | 'validate_http';

export interface ScannerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  profile: 'safe' | 'raw';
  image: string;
}

export interface ScannerHealth {
  available: boolean;
  detail: string;
  isolation: 'docker';
  image: string;
  profile: 'safe' | 'raw';
  enabled: boolean;
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
    private readonly rawImage = RAW_SCANNER_IMAGE,
    private readonly rawEnabled = process.env.AGENT_WORKBENCH_ENABLE_RAW_SCANNER === '1',
  ) {}

  rawProfileAvailable(): boolean {
    return this.rawEnabled;
  }

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

  async ffuf(
    target: string,
    options: { matchCodes: number[] },
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    const fuzzTarget = `${target.replace(/\/+$/, '')}/FUZZ`;
    return this.run(
      'ffuf',
      [
        '-s',
        '-noninteractive',
        '-json',
        '-w',
        '/opt/wordlists/common.txt',
        '-u',
        fuzzTarget,
        '-mc',
        options.matchCodes.join(','),
        '-rate',
        String(limits.requestsPerSecond),
        '-t',
        String(limits.concurrency),
        '-timeout',
        '10',
        '-maxtime',
        String(limits.maxRuntimeSeconds),
      ],
      undefined,
      limits,
      signal,
    );
  }

  async nmap(
    targets: string[],
    options: { ports: number[]; raw: boolean },
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    if (options.raw && !this.rawEnabled)
      throw new Error(
        'raw-socket scanner profile is disabled; set AGENT_WORKBENCH_ENABLE_RAW_SCANNER=1 at server startup',
      );
    const scanner = options.raw ? 'nmap_raw' : 'nmap_connect';
    return this.run(
      scanner,
      [
        options.raw ? '-sS' : '-sT',
        '-Pn',
        '-n',
        '--open',
        '--reason',
        '--max-retries',
        '1',
        '--max-rate',
        String(Math.max(1, limits.requestsPerSecond)),
        '--host-timeout',
        `${limits.maxRuntimeSeconds}s`,
        '-p',
        options.ports.join(','),
        '-oX',
        '-',
        '-iL',
        '-',
      ],
      lines(targets),
      limits,
      signal,
    );
  }

  async validateHttp(
    target: string,
    options: { method: 'GET' | 'HEAD' },
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    return this.run(
      'validate_http',
      [
        '--silent',
        '--show-error',
        '--include',
        '--request',
        options.method,
        '--proto',
        '=http,https',
        '--proto-redir',
        '=http,https',
        '--max-redirs',
        '0',
        '--connect-timeout',
        '5',
        '--max-time',
        String(Math.min(limits.maxRuntimeSeconds, 30)),
        '--max-filesize',
        String(Math.min(limits.maxOutputBytes, 2 * 1024 * 1024)),
        target,
      ],
      undefined,
      limits,
      signal,
    );
  }

  async health(): Promise<Record<ScannerName, ScannerHealth>> {
    const safe = await this.imageHealth(this.image);
    const raw = this.rawEnabled
      ? await this.imageHealth(this.rawImage)
      : {
          available: false,
          detail:
            'raw profile disabled; set AGENT_WORKBENCH_ENABLE_RAW_SCANNER=1 and build scanner:build:raw',
        };
    const safeNames = [
      'subfinder',
      'dnsx',
      'httpx',
      'katana',
      'nuclei',
      'ffuf',
      'nmap_connect',
      'validate_http',
    ] as const;
    return {
      ...(Object.fromEntries(
        safeNames.map((name) => [
          name,
          {
            ...safe,
            isolation: 'docker' as const,
            image: this.image,
            profile: 'safe' as const,
            enabled: true,
          },
        ]),
      ) as Record<(typeof safeNames)[number], ScannerHealth>),
      nmap_raw: {
        ...raw,
        isolation: 'docker',
        image: this.rawImage,
        profile: 'raw',
        enabled: this.rawEnabled,
      },
    };
  }

  private async imageHealth(image: string): Promise<{ available: boolean; detail: string }> {
    let available = false;
    let detail = `Docker image ${image} is not built`;
    try {
      const result = await execa(this.dockerBinary, ['image', 'inspect', image], {
        reject: false,
        timeout: 5000,
        extendEnv: false,
        env: dockerEnvironment(),
      });
      available = result.exitCode === 0;
      if (available) detail = `${image} ready`;
      else if (result.stderr) detail = clean(result.stderr).slice(0, 300);
    } catch (error) {
      detail = `Docker unavailable: ${safeMessage(error)}`;
    }
    return { available, detail };
  }

  private async run(
    scanner: ScannerName,
    scannerArgs: string[],
    input: string | undefined,
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    const raw = scanner === 'nmap_raw';
    if (raw && !this.rawEnabled) throw new Error('raw-socket scanner profile is disabled');
    const image = raw ? this.rawImage : this.image;
    const executable =
      scanner === 'nmap_connect' || scanner === 'nmap_raw'
        ? 'nmap'
        : scanner === 'validate_http'
          ? 'curl'
          : scanner;
    const containerName = `agent-workbench-scan-${randomUUID()}`;
    const args = [
      'run',
      '--rm',
      '--name',
      containerName,
      '--read-only',
      '--user',
      raw ? '0:0' : '65532:65532',
      '--cap-drop',
      'ALL',
      ...(raw ? ['--cap-add', 'NET_RAW'] : []),
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
      raw
        ? '/tmp:rw,noexec,nosuid,nodev,size=128m,uid=0,gid=0'
        : '/tmp:rw,noexec,nosuid,nodev,size=128m,uid=65532,gid=65532',
      '--env',
      'HOME=/tmp/home',
      '--env',
      'XDG_CACHE_HOME=/tmp/cache',
      '--env',
      'XDG_CONFIG_HOME=/tmp/config',
      '--label',
      `io.agent-workbench.role=scanner-${raw ? 'raw' : 'safe'}`,
      '-i',
      image,
      executable,
      ...scannerArgs,
    ];
    try {
      const result = await execa(this.dockerBinary, args, {
        input: input ?? '',
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
        profile: raw ? 'raw' : 'safe',
        image,
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
