// Shell + bash tools. Each invocation requires permission. A denylist
// blocks obviously destructive patterns up front so the model can't
// accidentally rm -rf / even with user consent. Output is truncated to
// keep context windows sane.

import { spawn } from 'node:child_process';
import type { Prompter } from '../permission/permission.js';
import { type Tool, argString } from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024;

/**
 * Advisory denylist for catastrophic commands. This is defense-in-depth
 * behind the per-command permission prompt, NOT a security boundary — a
 * determined model can phrase destructive work around it. It exists to
 * catch obvious foot-guns (rm -rf of root/top-level dirs, fork bombs,
 * disk wipes) before they reach a hurried "allow".
 */
export const DENY_PATTERNS: RegExp[] = [
  // rm -rf targeting root or a single top-level dir (/, /*, /home, /home/).
  // Matches short (-rf, -fr) and long (--recursive --force) flag forms, in
  // either order; deeper paths like /home/user are left to the operator.
  /\brm\b(?=[^|;&\n]*\s-{1,2}[a-z-]*r)(?=[^|;&\n]*\s-{1,2}[a-z-]*f)[^|;&\n]*\s\/[^/\s]*\/?(?:\s|$)/i,
  /:\(\)\s*\{\s*:\|:&\s*\}/i, // fork bomb
  /\bmkfs\b/i,
  /\bdd\b[^|;&\n]*\bof=\/dev\//i,
  />\s*\/dev\/sd[a-z]/i,
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /\bfind\b[^|;&\n]*\s-delete\b/i, // find / -delete
  /\bfind\b[^|;&\n]*\s-exec\s+rm\b/i, // find / -exec rm
];

export class ShellTool implements Tool {
  private readonly shellPath: string;
  private readonly toolName: string;

  constructor(shell = '/bin/sh', toolName = 'shell') {
    this.shellPath = shell;
    this.toolName = toolName;
  }

  name(): string {
    return this.toolName;
  }

  description(): string {
    return [
      'Run a shell command via /bin/sh -c on the local machine. Primary use case is curl + standard Unix utilities (jq, grep, awk, sed, head, sort, uniq) for HTTP testing, file inspection, and bash one-liners. The user will be prompted to approve each command. Capture concise output — pipe through `head` for huge outputs. Do not run interactive commands. Authorized engagements only.',
      '',
      'Default to curl for HTTP work; only use specialized scanners (ffuf, nuclei, sqlmap, etc.) when the user explicitly asks for them.',
    ].join('\n');
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute. Will run via /bin/sh -c.',
        },
        timeout_seconds: {
          type: 'integer',
          description: 'Optional timeout in seconds (default 300, max 1800).',
        },
      },
      required: ['command'],
    };
  }

  requiresPermission(): boolean {
    return true;
  }

  /** Arbitrary command execution: never cache an "allow session" grant, so
   *  one approval can't silently whitelist every later command. */
  permissionHints(): { noSessionCache: boolean } {
    return { noSessionCache: true };
  }

  summarize(args: Record<string, unknown>): { summary: string; detail: string } {
    const cmd = argString(args, 'command');
    const firstLine = cmd.split('\n', 1)[0] ?? '';
    const truncated = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
    return { summary: `${this.toolName}: ${truncated}`, detail: cmd };
  }

  async run(args: Record<string, unknown>, signal: AbortSignal, _p: Prompter): Promise<string> {
    const cmdStr = argString(args, 'command');
    if (!cmdStr) throw new Error('command is required');

    for (const re of DENY_PATTERNS) {
      if (re.test(cmdStr)) {
        throw new Error(`command blocked by denylist (matched ${re.source})`);
      }
    }

    const timeoutArg = args.timeout_seconds;
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (typeof timeoutArg === 'number' && timeoutArg > 0) {
      timeoutMs = Math.min(timeoutArg * 1000, MAX_TIMEOUT_MS);
    }

    return runWithCapture(this.shellPath, ['-c', cmdStr], timeoutMs, signal);
  }
}

/** BashTool is a PascalCase alias for ShellTool that uses /bin/bash. */
export class BashTool extends ShellTool {
  constructor() {
    super('/bin/bash', 'BashTool');
  }

  override description(): string {
    return "Run a bash command via /bin/bash -c on the local machine. Same gating as the shell tool (per-command permission, denylist, output truncation). Prefer this over `shell` when you need bash features like [[ ]] tests, process substitution <(...), arrays, or $'...' quoting.";
  }
}

function runWithCapture(
  cmd: string,
  argv: string[],
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<string> {
  return new Promise((resolveOut) => {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let timedOut = false;
    timer.unref?.();

    const child = spawn(cmd, argv, { signal: controller.signal });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    // Track every byte received (even bytes we stop retaining past the cap)
    // so the truncation marker is deterministic regardless of chunk sizes.
    let stdoutTotal = 0;
    let stderrTotal = 0;

    // Only the first MAX_OUTPUT_BYTES of each stream are ever shown, so we
    // stop *retaining* bytes past that point. Without this, a command like
    // `yes` or `cat /dev/zero` would grow these buffers until the process
    // OOMs — the truncate() at close caps what the model sees, not memory.
    // We keep consuming (and discarding) data so the child isn't blocked on
    // backpressure; the timeout still bounds total runtime.
    child.stdout.on('data', (c: Buffer) => {
      stdoutTotal += c.length;
      if (stdoutLen < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(c);
        stdoutLen += c.length;
      }
    });
    child.stderr.on('data', (c: Buffer) => {
      stderrTotal += c.length;
      if (stderrLen < MAX_OUTPUT_BYTES) {
        stderrChunks.push(c);
        stderrLen += c.length;
      }
    });

    child.on('close', (code, sig) => {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
      const stdout = truncate(Buffer.concat(stdoutChunks).toString('utf8'), stdoutTotal);
      const stderr = truncate(Buffer.concat(stderrChunks).toString('utf8'), stderrTotal);

      if (controller.signal.aborted && !parentSignal.aborted) {
        timedOut = true;
      }
      if (timedOut) {
        resolveOut(
          `exit: timeout after ${timeoutMs / 1000}s\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
        return;
      }

      const exitCode = code ?? (sig ? 128 + signalToInt(sig) : 0);
      let result = `exit: ${exitCode}\nstdout:\n${stdout}`;
      if (stderr) result += `\nstderr:\n${stderr}`;
      resolveOut(result);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
      const stdout = truncate(Buffer.concat(stdoutChunks).toString('utf8'), stdoutTotal);
      const stderr = truncate(Buffer.concat(stderrChunks).toString('utf8'), stderrTotal);
      resolveOut(`exit: -1\nstdout:\n${stdout}\nstderr:\n${stderr}\nerror: ${err.message}`);
    });
  });
}

function truncate(s: string, total?: number): string {
  const seen = total ?? s.length;
  if (seen <= MAX_OUTPUT_BYTES) return s;
  return `${s.slice(0, MAX_OUTPUT_BYTES)}\n[... truncated ${seen - MAX_OUTPUT_BYTES} bytes ...]`;
}

function signalToInt(sig: NodeJS.Signals): number {
  // Best-effort mapping for the most common signals so the exit code is
  // still meaningful in the tool output.
  switch (sig) {
    case 'SIGINT':
      return 2;
    case 'SIGKILL':
      return 9;
    case 'SIGTERM':
      return 15;
    default:
      return 1;
  }
}
