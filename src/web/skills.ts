import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { skillSearchDirs } from '../skills/discovery.js';
import { Registry } from '../skills/registry.js';

const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(
      z
        .object({
          name: z.string(),
          category: z.string(),
          risk: z.enum(['low', 'medium', 'high']),
          compatibility: z.array(z.enum(['cli', 'web'])),
          source: z
            .string()
            .url()
            .refine((value) => new URL(value).protocol === 'https:', 'source must use HTTPS'),
          sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
          license: z.string(),
          provenance: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export interface WebSkillSummary {
  name: string;
  description: string;
  explicitOnly: boolean;
  category: string;
  risk: 'low' | 'medium' | 'high';
  compatibility: Array<'cli' | 'web'>;
  source: string;
  sourceCommit?: string;
  license: string;
  provenance: string;
}

export function loadWebSkillRegistry(): Registry {
  const registry = new Registry();
  for (const directory of skillSearchDirs([])) registry.loadDir(directory);
  return registry;
}

export function listWebSkills(): WebSkillSummary[] {
  const registry = loadWebSkillRegistry();
  const catalogPath = resolve(process.cwd(), 'skills', 'catalog.json');
  const catalog = new Map<string, z.infer<typeof catalogSchema>['entries'][number]>();
  try {
    for (const entry of catalogSchema.parse(JSON.parse(readFileSync(catalogPath, 'utf8'))).entries)
      catalog.set(entry.name, entry);
  } catch {
    // The registry remains usable if optional provenance metadata is missing.
  }
  return registry.list().map((skill) => {
    const metadata = catalog.get(skill.name);
    return {
      name: skill.name,
      description: skill.description,
      explicitOnly: skill.disableModelInvocation,
      category: metadata?.category ?? inferCategory(skill.name),
      risk: metadata?.risk ?? 'medium',
      compatibility: metadata?.compatibility ?? ['cli', 'web'],
      source: metadata?.source ?? 'https://github.com/rust-memo/agent-workbench/tree/main/skills',
      sourceCommit: metadata?.sourceCommit,
      license: metadata?.license ?? 'Apache-2.0',
      provenance: metadata?.provenance ?? 'Included in the core Agent Workbench skill catalog.',
    };
  });
}

function inferCategory(name: string): string {
  if (['recon', 'takeover'].includes(name)) return 'recon';
  if (['jwt', 'oauth-oidc', 'api-authorization'].includes(name)) return 'identity';
  if (['graphql', 'supabase'].includes(name)) return 'api';
  return 'web';
}
