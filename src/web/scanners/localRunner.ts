import { execa } from 'execa';

export interface ScannerLimits {
  maxRuntimeSeconds: number;
  maxOutputBytes: number;
}

export interface ScannerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * v0.2 host runner. Commands and every flag are server-owned; no raw command,
 * image, environment, path, or shell input is accepted from the model/API.
 * v0.2 swaps this interface for the Docker runner.
 */
export class LocalScannerRunner {
  async subfinder(
    domain: string,
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    return this.run(
      'subfinder',
      ['-silent', '-d', domain, '-timeout', '30'],
      undefined,
      limits,
      signal,
    );
  }

  async httpx(
    targets: string[],
    options: { requestsPerSecond: number; concurrency: number; followRedirects: boolean },
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    const args = [
      '-silent',
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
    ];
    if (options.followRedirects) args.push('-follow-redirects', '-max-redirects', '1');
    return this.run('httpx', args, `${targets.join('\n')}\n`, limits, signal);
  }

  async health(): Promise<Record<'subfinder' | 'httpx', { available: boolean; detail: string }>> {
    const probe = async (binary: string): Promise<{ available: boolean; detail: string }> => {
      try {
        const result = await execa(binary, ['-version'], { reject: false, timeout: 3000 });
        return {
          available: result.exitCode === 0,
          detail: clean(`${result.stdout}\n${result.stderr}`).slice(0, 300),
        };
      } catch (error) {
        return { available: false, detail: error instanceof Error ? error.message : String(error) };
      }
    };
    const [subfinder, httpx] = await Promise.all([probe('subfinder'), probe('httpx')]);
    return { subfinder, httpx };
  }

  private async run(
    binary: 'subfinder' | 'httpx',
    args: string[],
    input: string | undefined,
    limits: ScannerLimits,
    signal: AbortSignal,
  ): Promise<ScannerResult> {
    try {
      const result = await execa(binary, args, {
        input,
        cancelSignal: signal,
        reject: false,
        timeout: limits.maxRuntimeSeconds * 1000,
        maxBuffer: limits.maxOutputBytes,
        extendEnv: false,
        env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      });
      return {
        stdout: clean(result.stdout),
        stderr: clean(result.stderr),
        exitCode: result.exitCode ?? 1,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(
        `${binary} is unavailable or failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Strip terminal control sequences before they reach logs or browser JSON. */
export function clean(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC is untrusted terminal control data we intentionally remove.
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI is untrusted terminal control data we intentionally remove.
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: C0 controls are intentionally stripped from scanner output.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, '')
  );
}
