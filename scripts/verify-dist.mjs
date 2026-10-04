import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BUILD_OPTIONS } from './build.mjs';

// The committed bundle must be exactly what the sources build to, and it must start.
const result = await build({ ...BUILD_OPTIONS, write: false });
const fresh = result.outputFiles[0].text;
const committed = readFileSync('dist/cli.mjs', 'utf8');
if (fresh !== committed) {
  console.error('dist/cli.mjs is stale: run `npm run build` and commit the result.');
  process.exit(1);
}
const version = execFileSync(process.execPath, ['dist/cli.mjs', '--version'], { encoding: 'utf8' }).trim();
console.log(`dist/cli.mjs is current (${version}).`);
