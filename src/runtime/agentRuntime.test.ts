import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../llm/client.js';
import type { ChatRequest, ChatResponse } from '../llm/types.js';
import { AlwaysAllow } from '../permission/permission.js';
import { JsonSessionStore } from '../session/store.js';
import { Registry as SkillRegistry } from '../skills/registry.js';
import { Target } from '../target/target.js';
import { Registry as ToolRegistry } from '../tools/registry.js';
import { createAgentRuntime } from './agentRuntime.js';

class EchoClient implements Client {
  model(): string {
    return 'runtime-test';
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const latest = [...request.messages].reverse().find((message) => message.role === 'user');
    return {
      message: { role: 'assistant', content: `echo:${latest?.content ?? ''}` },
      finishReason: 'stop',
    };
  }
}

describe('shared AgentRuntime', () => {
  let root = '';

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('persists and resumes the stable CLI JSON session schema without UI dependencies', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-runtime-cli-'));
    const sessionPath = join(root, 'legacy-compatible.json');
    const store = new JsonSessionStore(sessionPath, 'legacy-compatible');
    const runtime = createAgentRuntime(
      {
        client: new EchoClient(),
        tools: new ToolRegistry(),
        skills: new SkillRegistry(),
        prompter: new AlwaysAllow(),
        store,
        target: new Target(),
        streamingEnabled: false,
      },
      'cli',
    );
    await runtime.run('hello runtime', new AbortController().signal, () => undefined, {
      tools: false,
    });

    const saved = JSON.parse(await readFile(sessionPath, 'utf8')) as {
      id: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(saved.id).toBe('legacy-compatible');
    expect(saved.messages.some((message) => message.content === 'hello runtime')).toBe(true);
    expect(saved.messages.some((message) => message.content === 'echo:hello runtime')).toBe(true);

    const resumed = createAgentRuntime(
      {
        client: new EchoClient(),
        tools: new ToolRegistry(),
        skills: new SkillRegistry(),
        prompter: new AlwaysAllow(),
        store: new JsonSessionStore(sessionPath, 'legacy-compatible'),
        target: new Target(),
        streamingEnabled: false,
      },
      'cli',
    );
    resumed.agent.resumeSaved();
    expect(resumed.agent.getHistory().some((message) => message.content === 'hello runtime')).toBe(
      true,
    );
  });
});
