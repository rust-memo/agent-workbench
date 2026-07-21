import { describe, expect, it } from 'vitest';
import {
  WEB_SLASH_COMMANDS,
  commandUsesProvider,
  parseWebCommand,
  webCommandHelp,
} from './commands.js';

describe('Web slash commands', () => {
  it('parses names case-insensitively while preserving argument text', () => {
    expect(parseWebCommand('  /PLAN audit login flow  ')).toEqual({
      name: '/plan',
      args: ['audit', 'login', 'flow'],
      argumentText: 'audit login flow',
    });
    expect(parseWebCommand('plain text')).toBeUndefined();
  });

  it('requires external-provider approval only for model-backed commands', () => {
    expect(commandUsesProvider('/plan test auth')).toBe(true);
    expect(commandUsesProvider('/next')).toBe(true);
    expect(commandUsesProvider('/compact')).toBe(true);
    expect(commandUsesProvider('/help')).toBe(false);
    expect(commandUsesProvider('/model list')).toBe(false);
  });

  it('publishes every documented command in help', () => {
    const help = webCommandHelp();
    for (const command of WEB_SLASH_COMMANDS) expect(help).toContain(command.name);
    expect(WEB_SLASH_COMMANDS.map((command) => command.name)).toEqual(
      expect.arrayContaining([
        '/help',
        '/provider',
        '/model',
        '/plan',
        '/next',
        '/target',
        '/compact',
        '/memory',
        '/snapshot',
        '/burp',
        '/skills',
        '/maxsteps',
        '/thinking',
        '/update',
        '/yolo',
        '/reset',
        '/clear',
        '/exit',
      ]),
    );
  });
});
