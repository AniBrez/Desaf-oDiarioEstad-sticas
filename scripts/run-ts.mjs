#!/usr/bin/env node
/**
 * Runs a TypeScript file from this repository in Node: bundles it with esbuild into .cache/run
 * and imports the result. Used for the development scripts that share code with the app.
 *
 *   node scripts/run-ts.mjs <file.ts> [args...]
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.argv[2];
if (!entry) {
  console.error('Usage: node scripts/run-ts.mjs <file.ts> [args...]');
  process.exit(1);
}
const outDir = path.join(root, '.cache', 'run');
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, path.basename(entry).replace(/\.ts$/, '') + '.mjs');
await build({
  entryPoints: [path.resolve(entry)],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  define: { 'import.meta.env.BASE_URL': '"/"' },
  logLevel: 'warning',
});
process.argv.splice(1, 2, outfile);
await import(pathToFileURL(outfile).href);
