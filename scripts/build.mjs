import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

/** One self-contained file, so a plugin install needs no `npm install`. */
export const BUILD_OPTIONS = {
  entryPoints: ['src/cli/bin.ts'],
  outfile: 'dist/cli.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  legalComments: 'inline',
  logLevel: 'warning',
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await build(BUILD_OPTIONS);
  chmodSync('dist/cli.mjs', 0o755);
}
