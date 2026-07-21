export interface WebSlashCommand {
  name: string;
  args?: string;
  description: string;
}

export const WEB_SLASH_COMMANDS: WebSlashCommand[] = [
  { name: '/help', description: 'Show the Web command reference.' },
  { name: '/provider', description: 'Show detected providers and open the provider switcher.' },
  {
    name: '/model',
    args: '<id|list>',
    description: 'Switch or list models for the current provider.',
  },
  { name: '/plan', args: '[objective]', description: 'Run a plan-only turn without tools.' },
  {
    name: '/next',
    args: '[objective]',
    description: 'Suggest the next coverage-oriented tests without tools.',
  },
  {
    name: '/target',
    args: '<url>',
    description: 'Set an in-scope base URL; no argument clears it.',
  },
  { name: '/compact', description: 'Summarize the conversation into persistent session memory.' },
  {
    name: '/memory',
    args: '[forget <text>|clear]',
    description: 'Show or manage persistent session memory.',
  },
  { name: '/snapshot', description: 'Save a redacted context snapshot in SQLite.' },
  {
    name: '/burp',
    args: '[port]',
    description: 'Show how to start the separate local Burp bridge.',
  },
  {
    name: '/skills',
    args: '[enable|disable <name>]',
    description: 'List, toggle, or invoke loaded Web skills.',
  },
  { name: '/maxsteps', args: '<n>', description: 'Set the per-turn tool-call cap.' },
  { name: '/thinking', args: 'on|off', description: 'Toggle visible reasoning guidance.' },
  { name: '/update', args: '[version]', description: 'Show the safe terminal update command.' },
  {
    name: '/yolo',
    args: '[on|off]',
    description: 'Explain the Web approval policy (cannot bypass it).',
  },
  { name: '/reset', description: 'Clear conversation and saved session state.' },
  { name: '/clear', description: 'Clear only this browser transcript view.' },
  { name: '/exit', description: 'Disconnect this browser view; stop the server in its terminal.' },
];

export interface ParsedWebCommand {
  name: string;
  args: string[];
  argumentText: string;
}

export function parseWebCommand(raw: string): ParsedWebCommand | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const separator = trimmed.search(/\s/);
  const name = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
  const argumentText = separator === -1 ? '' : trimmed.slice(separator).trim();
  return { name, args: argumentText ? argumentText.split(/\s+/) : [], argumentText };
}

export function commandUsesProvider(raw: string): boolean {
  const name = parseWebCommand(raw)?.name;
  return name === '/plan' || name === '/next' || name === '/compact';
}

export function webCommandHelp(): string {
  return [
    'Agent Workbench Web commands',
    '',
    ...WEB_SLASH_COMMANDS.map(
      (command) =>
        `${command.name}${command.args ? ` ${command.args}` : ''}\n  ${command.description}`,
    ),
    '',
    'Type / to open command completion. Web commands never execute raw shell text.',
  ].join('\n');
}
