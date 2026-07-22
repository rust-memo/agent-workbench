import { Agent, type AgentOptions, type AgentRunOptions, type EventSink } from '../agent/agent.js';

/**
 * UI-agnostic runtime boundary shared by the Ink CLI and the Web control plane.
 *
 * Composition roots still choose their own providers, tools, permissions, and
 * persistence adapters. This module deliberately imports neither Ink/React nor
 * Express/SQLite, so the agent loop can evolve without coupling either UI to
 * the other one's infrastructure.
 */
export class AgentRuntime {
  readonly agent: Agent;

  constructor(
    options: AgentOptions,
    readonly surface: 'cli' | 'web',
  ) {
    this.agent = new Agent(options);
  }

  run(
    input: string,
    signal: AbortSignal,
    sink: EventSink,
    options?: AgentRunOptions,
  ): Promise<void> {
    return this.agent.run(input, signal, sink, options);
  }
}

export function createAgentRuntime(options: AgentOptions, surface: 'cli' | 'web'): AgentRuntime {
  return new AgentRuntime(options, surface);
}
