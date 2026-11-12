#!/usr/bin/env node
/**
 * Bundles the collector (src/collector) into one readable script, public/collector.js.
 * The app serves that file: it is what the bookmarklet loads and what "Copy script" copies.
 * It is deliberately not minified, so anyone can read what they are about to run.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src/collector/entry.ts')],
  outfile: path.join(root, 'public/collector.js'),
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: false,
  legalComments: 'none',
  banner: {
    js: [
      '/*',
      ' * Desafío Diario collector.',
      ' * Runs on geoguessr.com in your own signed-in tab and reads your Daily Challenge history',
      ' * (and your friends\' results on the same challenges) using read-only requests.',
      ' * Your session never leaves the page; the result goes only where you send it.',
      ' */',
    ].join('\n'),
  },
  logLevel: 'warning',
});
console.log('Built public/collector.js');
