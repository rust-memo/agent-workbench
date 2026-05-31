// End-to-end agent loop test using a fake LLM client. Exercises:
//   - user message → assistant tool call → tool result → final assistant text
//   - signal abort propagates
//   - tool failure surfaces as tool-result with err

import { describe, expect, it } from 'vitest';
import type { Client } from '../llm/client.js';
import type { ChatRequest, ChatResponse } from '../llm/types.js';
import { AlwaysAllow } from '../permission/permission.js';
import { Registry as SkillRegistry } from '../skills/registry.js';
import { Target } from '../target/target.js';
import { Registry as ToolRegistry } from '../tools/registry.js';
import type { Tool } from '../tools/types.js';
import { Agent } from './agent.js';
import type { AgentEvent } from './events.js';

// Minimal fake client: scripted responses cycled per chat() call.
class FakeClient implements Client {
  private scripted: ChatResponse[];
  private idx = 0;
  constructor(scripted: ChatResponse[]) {
    this.scripted = scripted;
  }
  name(): string {
    return 'fake';
  }
  model(): string {
    return 'fake-model';
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    const r = this.scripted[this.idx++];
    if (!r) throw new Error('FakeClient: script exhausted');
    return r;
  }
}

class EchoTool implements Tool {
  name(): string {
    return 'echo';
  }
  description(): string {
    return 'echo';
  }
  schema(): Record<string, unknown> {
    return { type: 'object', properties: { msg: { type: 'string' } } };
  }
  requiresPermission(): boolean {
    return false;
  }
  async run(args: Record<string, unknown>): Promise<string> {
    return `echoed: ${String(args.msg ?? '')}`;
  }
}

function makeAgent(scripted: ChatResponse[]): Agent {
  const tools = new ToolRegistry();
  tools.register(new EchoTool());
  return new Agent({
    client: new FakeClient(scripted),
    tools,
    skills: new SkillRegistry(),
    prompter: new AlwaysAllow(),
    store: null,
    target: new Target(),
  });
}

function collect(): { events: AgentEvent[]; sink: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, sink: (e: AgentEvent) => events.push(e) };
}

describe('Agent.run', () => {
  it('completes a turn with a single assistant text response', async () => {
    const a = makeAgent([
      {
        message: { role: 'assistant', content: 'hello there' },
        finishReason: 'stop',
      },
    ]);
    const { events, sink } = collect();
    await a.run('hi', new AbortController().signal, sink);
    const texts = events.filter((e) => e.type === 'assistant-text');
    expect(texts).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('runs a tool call and feeds the result back into the loop', async () => {
    const a = makeAgent([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'echo', arguments: JSON.stringify({ msg: 'ping' }) },
            },
          ],
        },
        finishReason: 'tool_calls',
      },
      {
        message: { role: 'assistant', content: 'done' },
        finishReason: 'stop',
      },
    ]);
    const { events, sink } = collect();
    await a.run('do it', new AbortController().signal, sink);
    const types = events.map((e) => e.type);
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    const result = events.find((e) => e.type === 'tool-result');
    expect(result && result.type === 'tool-result' ? result.result : '').toContain('echoed: ping');
  });

  it('surfaces a tool failure as a tool-result with err set', async () => {
    const a = makeAgent([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_x',
              type: 'function',
              function: { name: 'nonexistent', arguments: '{}' },
            },
          ],
        },
        finishReason: 'tool_calls',
      },
      {
        message: { role: 'assistant', content: 'oh well' },
        finishReason: 'stop',
      },
    ]);
    const { events, sink } = collect();
    await a.run('go', new AbortController().signal, sink);
    const result = events.find((e) => e.type === 'tool-result');
    expect(result && result.type === 'tool-result' ? result.err : '').toContain('unknown tool');
  });

  it('auto-compacts before the next turn when over threshold', async () => {
    // Two scripted responses: the first is the compaction summary
    // (a single assistant message in response to the compaction
    // request), the second answers the user's actual turn.
    const compactSummary: ChatResponse = {
      message: { role: 'assistant', content: 'Compacted summary of prior turn.' },
      finishReason: 'stop',
    };
    const userTurn: ChatResponse = {
      message: { role: 'assistant', content: 'answer' },
      finishReason: 'stop',
    };

    const tools = new ToolRegistry();
    tools.register(new EchoTool());
    const agent = new Agent({
      client: new FakeClient([compactSummary, userTurn]),
      tools,
      skills: new SkillRegistry(),
      prompter: new AlwaysAllow(),
      store: null,
      target: new Target(),
      autoCompactThreshold: 1, // pretty much always fires
    });

    const { events, sink } = collect();
    await agent.run('hi', new AbortController().signal, sink);
    const compactEvents = events.filter((e) => e.type === 'compact');
    // We expect two compact events: "triggered" + "after" outcome.
    expect(compactEvents.length).toBeGreaterThanOrEqual(2);
    const last = compactEvents[compactEvents.length - 1];
    expect(last && last.type === 'compact' ? last.summary : '').toContain('auto-compacted');
  });

  it('circuit-breaker stops retrying auto-compact after 3 failures', async () => {
    // Every chat call throws — auto-compact should fail, increment the
    // counter, and after 3 failures stop trying. We seed enough tokens
    // by passing a very low threshold.
    class FlakyClient implements Client {
      calls = 0;
      name() {
        return 'flaky';
      }
      model() {
        return 'm';
      }
      async chat(): Promise<ChatResponse> {
        this.calls += 1;
        throw new Error('compact-fail');
      }
    }
    const flaky = new FlakyClient();
    const agent = new Agent({
      client: flaky,
      tools: new ToolRegistry(),
      skills: new SkillRegistry(),
      prompter: new AlwaysAllow(),
      store: null,
      target: new Target(),
      autoCompactThreshold: 1,
    });
    // Drive 5 turns. The first 3 attempt auto-compact (each does 1 chat
    // call: the compaction request, which throws); the 4th and 5th
    // skip compaction entirely. The follow-up Run still tries to call
    // the model — that's 1 more call per turn. So: 3 compaction calls
    // + 5 turn calls = 8 total. The exact ratio isn't the point; what
    // we care about is that the compaction *attempts* cap at 3.
    for (let i = 0; i < 5; i += 1) {
      const { sink } = collect();
      await agent.run(`turn ${i}`, new AbortController().signal, sink);
    }
    // 3 compaction attempts (each made 1 chat call) + 5 turn attempts
    // (each made 1 chat call) = 8.
    expect(flaky.calls).toBe(8);
  });

  it('emits an error event when a panic escapes', async () => {
    class CrashClient implements Client {
      name() {
        return 'crash';
      }
      model() {
        return 'm';
      }
      async chat(): Promise<ChatResponse> {
        throw new Error('boom');
      }
    }
    const a = new Agent({
      client: new CrashClient(),
      tools: new ToolRegistry(),
      skills: new SkillRegistry(),
      prompter: new AlwaysAllow(),
      store: null,
      target: new Target(),
    });
    const { events, sink } = collect();
    await a.run('x', new AbortController().signal, sink);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('renders user cancellation without leaking backend abort text', async () => {
    class AbortClient implements Client {
      name() {
        return 'ollama';
      }
      model() {
        return 'm';
      }
      async chat(_req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
        signal?.throwIfAborted();
        throw new Error('ollama: The operation was aborted.');
      }
    }
    const a = new Agent({
      client: new AbortClient(),
      tools: new ToolRegistry(),
      skills: new SkillRegistry(),
      prompter: new AlwaysAllow(),
      store: null,
      target: new Target(),
    });
    const ctl = new AbortController();
    const { events, sink } = collect();
    ctl.abort();
    await a.run('x', ctl.signal, sink);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent && errorEvent.type === 'error' ? errorEvent.err.message : '').toBe(
      'turn cancelled',
    );
    expect(events.at(-1)?.type).toBe('done');
  });

  // ----- allowed-tools enforcement (Tier 1 #3) -----

  // A capability tool (requiresPermission=true) that the test will try
  // to invoke under skill restriction.
  class RestrictedShellTool implements Tool {
    name(): string {
      return 'shell';
    }
    description(): string {
      return 'shell';
    }
    schema(): Record<string, unknown> {
      return { type: 'object', properties: { command: { type: 'string' } } };
    }
    requiresPermission(): boolean {
      return true; // subject to the skill allowlist
    }
    async run(args: Record<string, unknown>): Promise<string> {
      return `ran: ${String(args.command ?? '')}`;
    }
  }

  // The load_skill replacement for these tests — built-in registry's
  // LoadSkillTool would re-parse from disk; here we just synthesize the
  // tool result directly so we can craft minimal skills.
  function fakeLoadSkillTool(reg: SkillRegistry): Tool {
    return {
      name: () => 'load_skill',
      description: () => 'load_skill',
      schema: () => ({ type: 'object', properties: { name: { type: 'string' } } }),
      requiresPermission: () => false, // workflow → always allowed
      async run(args: Record<string, unknown>) {
        const nm = typeof args.name === 'string' ? args.name : '';
        const s = reg.get(nm);
        if (!s) throw new Error(`unknown ${nm}`);
        return s.body;
      },
    };
  }

  function makeAgentWithSkill(
    scripted: ChatResponse[],
    skillTools: string[],
  ): { agent: Agent; events: AgentEvent[]; sink: (e: AgentEvent) => void } {
    const tools = new ToolRegistry();
    tools.register(new EchoTool());
    tools.register(new RestrictedShellTool());
    const skills = new SkillRegistry();
    skills.add({
      name: 'narrow',
      description: 'narrow skill',
      tools: skillTools,
      disableModelInvocation: false,
      path: '/virtual/narrow/SKILL.md',
      body: '# narrow body',
    });
    tools.register(fakeLoadSkillTool(skills));
    const agent = new Agent({
      client: new FakeClient(scripted),
      tools,
      skills,
      prompter: new AlwaysAllow(),
      store: null,
      target: new Target(),
    });
    const { events, sink } = collect();
    return { agent, events, sink };
  }

  it("blocks a capability tool not listed in the active skill's allowed-tools", async () => {
    // Loop: 1) load_skill(narrow) → 2) shell — should be blocked because
    // `narrow` only allows `echo`; 3) final assistant text.
    const { agent, events, sink } = makeAgentWithSkill(
      [
        {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'load_skill', arguments: JSON.stringify({ name: 'narrow' }) },
              },
            ],
          },
          finishReason: 'tool_calls',
        },
        {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'shell', arguments: JSON.stringify({ command: 'id' }) },
              },
            ],
          },
          finishReason: 'tool_calls',
        },
        { message: { role: 'assistant', content: 'understood' }, finishReason: 'stop' },
      ],
      ['echo'], // narrow's allowed tools — shell NOT in here
    );
    await agent.run('go', new AbortController().signal, sink);
    const shellResult = events.find((e) => e.type === 'tool-result' && e.name === 'shell');
    expect(shellResult && shellResult.type === 'tool-result' ? shellResult.err : '').toMatch(
      /not in any active skill/,
    );
  });

  it("allows a capability tool listed in the active skill's allowed-tools", async () => {
    const { agent, events, sink } = makeAgentWithSkill(
      [
        {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'load_skill', arguments: JSON.stringify({ name: 'narrow' }) },
              },
            ],
          },
          finishReason: 'tool_calls',
        },
        {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'shell', arguments: JSON.stringify({ command: 'id' }) },
              },
            ],
          },
          finishReason: 'tool_calls',
        },
        { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' },
      ],
      ['shell', 'echo'], // narrow allows both
    );
    await agent.run('go', new AbortController().signal, sink);
    const shellResult = events.find((e) => e.type === 'tool-result' && e.name === 'shell');
    expect(shellResult && shellResult.type === 'tool-result' ? shellResult.err : '').toBe('');
    expect(shellResult && shellResult.type === 'tool-result' ? shellResult.result : '').toContain(
      'ran:',
    );
  });

  it('treats an active skill with empty allowed-tools as no restriction (CC semantics)', async () => {
    // `narrow` omits allowed-tools → it should NOT narrow anything, so
    // shell runs even though the skill is active.
    const { agent, events, sink } = makeAgentWithSkill(
      [
        {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'load_skill', arguments: JSON.stringify({ name: 'narrow' }) },
              },
            ],
          },
          finishReason: 'tool_calls',
        },
        {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'shell', arguments: JSON.stringify({ command: 'id' }) },
              },
            ],
          },
          finishReason: 'tool_calls',
        },
        { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' },
      ],
      [], // empty allowed-tools → unrestricted
    );
    await agent.run('go', new AbortController().signal, sink);
    const shellResult = events.find((e) => e.type === 'tool-result' && e.name === 'shell');
    expect(shellResult && shellResult.type === 'tool-result' ? shellResult.err : '').toBe('');
  });

  it('places no restriction when no skill has been loaded yet', async () => {
    // No load_skill call — `shell` should run freely.
    const { agent, events, sink } = makeAgentWithSkill(
      [
        {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_x',
                type: 'function',
                function: { name: 'shell', arguments: JSON.stringify({ command: 'whoami' }) },
              },
            ],
          },
          finishReason: 'tool_calls',
        },
        { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
      ],
      ['echo'],
    );
    await agent.run('go', new AbortController().signal, sink);
    const r = events.find((e) => e.type === 'tool-result' && e.name === 'shell');
    expect(r && r.type === 'tool-result' ? r.err : '').toBe('');
  });

  it('allows BashTool when the active skill declared "shell" (alias equivalence)', async () => {
    // Regression for: pentesterflow registers shell + BashTool side-by-
    // side; some models reach for BashTool, but skill
    // authors write the Unix `shell` in their `tools:` list. The
    // enforcer canonicalizes both sides so the call goes through.
    const tools = new ToolRegistry();
    // Register both names pointing at the same underlying tool.
    tools.register({
      name: () => 'shell',
      description: () => 'shell',
      schema: () => ({ type: 'object', properties: { command: { type: 'string' } } }),
      requiresPermission: () => true,
      run: async () => 'unused (we exercise the BashTool branch)',
    });
    tools.register({
      name: () => 'BashTool',
      description: () => 'bash',
      schema: () => ({ type: 'object', properties: { command: { type: 'string' } } }),
      requiresPermission: () => true,
      run: async (args) => `bashed: ${String(args.command ?? '')}`,
    });
    const skills = new SkillRegistry();
    skills.add({
      name: 'unix-skill',
      description: 'declares the Unix name',
      tools: ['shell'], // canonical Unix spelling
      disableModelInvocation: false,
      path: '/virtual/unix/SKILL.md',
      body: '',
    });
    tools.register({
      name: () => 'load_skill',
      description: () => 'load_skill',
      schema: () => ({ type: 'object', properties: { name: { type: 'string' } } }),
      requiresPermission: () => false,
      async run(args) {
        const nm = typeof args.name === 'string' ? args.name : '';
        if (!skills.get(nm)) throw new Error(`unknown ${nm}`);
        return skills.get(nm)?.body ?? '';
      },
    });
    const agent = new Agent({
      client: new FakeClient([
        {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'c1',
                type: 'function',
                function: {
                  name: 'load_skill',
                  arguments: JSON.stringify({ name: 'unix-skill' }),
                },
              },
            ],
          },
          finishReason: 'tool_calls',
        },
        {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'c2',
                type: 'function',
                function: {
                  name: 'BashTool', // PascalCase name; should be allowed via canonicalization
                  arguments: JSON.stringify({ command: 'id' }),
                },
              },
            ],
          },
          finishReason: 'tool_calls',
        },
        { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' },
      ]),
      tools,
      skills,
      prompter: new AlwaysAllow(),
      store: null,
      target: new Target(),
    });
    const { events, sink } = collect();
    await agent.run('go', new AbortController().signal, sink);
    const bashResult = events.find((e) => e.type === 'tool-result' && e.name === 'BashTool');
    expect(bashResult && bashResult.type === 'tool-result' ? bashResult.err : '').toBe('');
    expect(bashResult && bashResult.type === 'tool-result' ? bashResult.result : '').toContain(
      'bashed: id',
    );
  });
});
