import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const version: string = JSON.parse(readFileSync('./package.json', 'utf8')).version;
const shared = {
  format: ['esm'] as const,
  platform: 'node' as const,
  outDir: 'dist',
  define: { __BUILD_VERSION__: JSON.stringify(version) },
  splitting: false,
  shims: false,
  sourcemap: true,
  external: ['react-devtools-core', 'yoga-wasm-web', 'bufferutil', 'utf-8-validate'],
  banner: { js: '#!/usr/bin/env node' },
};

export default defineConfig([
  {
    ...shared,
    entry: { cli: 'src/cli/index.ts', 'browser-mcp': 'src/browser/mcpServer.ts' },
    target: 'node20',
    clean: true,
  },
  {
    ...shared,
    entry: { web: 'src/web/index.ts' },
    target: 'node22',
    clean: false,
    external: shared.external,
  },
]);
