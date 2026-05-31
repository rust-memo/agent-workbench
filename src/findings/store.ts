// Findings store. Confirmed vulnerabilities are written to
// ./findings/<slug>.md so different engagements stay separate (per cwd)
// without configuration. Mirrors internal/findings/findings.go shape.

import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  title: string;
  severity: Severity;
  url: string;
  parameter?: string;
  payload?: string;
  method?: string;
  responseExcerpt?: string;
  impact: string;
  curl?: string;
  remediation?: string;
  createdAt: string; // ISO timestamp
  slug: string;
}

export class Store {
  readonly dir: string;

  constructor(dir = 'findings') {
    this.dir = resolve(dir);
  }

  /** Render the finding as markdown and persist it. Returns the file path. */
  async save(finding: Finding): Promise<string> {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    const path = join(this.dir, `${finding.slug}.md`);
    await writeFile(path, render(finding), { encoding: 'utf8', mode: 0o600 });
    return path;
  }
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 64);
}

function render(f: Finding): string {
  const lines: string[] = [];
  lines.push(`# ${f.title}`, '');
  lines.push(`- **Severity:** ${f.severity}`);
  lines.push(`- **URL:** ${f.url}`);
  if (f.method) lines.push(`- **Method:** ${f.method}`);
  if (f.parameter) lines.push(`- **Parameter:** ${f.parameter}`);
  lines.push(`- **Reported at:** ${f.createdAt}`);
  lines.push('', '## Impact', '', f.impact, '');
  if (f.payload) {
    lines.push('## Payload', '', '```', f.payload, '```', '');
  }
  if (f.responseExcerpt) {
    lines.push('## Response excerpt', '', '```', f.responseExcerpt, '```', '');
  }
  if (f.curl) {
    lines.push('## Reproduce', '', '```sh', f.curl, '```', '');
  }
  if (f.remediation) {
    lines.push('## Remediation', '', f.remediation, '');
  }
  return lines.join('\n');
}
