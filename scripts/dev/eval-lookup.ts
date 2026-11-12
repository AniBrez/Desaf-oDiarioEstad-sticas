/**
 * Measures how well the shipped (simplified) regions reproduce the full-resolution assignment.
 * Input: a sample written by `build-geodata.mjs --sample-out <file>`.
 *
 *   node scripts/run-ts.mjs scripts/dev/eval-lookup.ts <sample.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Topology } from 'topojson-specification';
import { buildGeo, type CoverageFile } from '../../src/geo/geo';

const dir = path.resolve('public/data');
const topology = JSON.parse(fs.readFileSync(path.join(dir, 'regions.topo.json'), 'utf8')) as Topology;
const coverage = JSON.parse(fs.readFileSync(path.join(dir, 'coverage.json'), 'utf8')) as CoverageFile;
const geo = buildGeo(topology, coverage, new Uint8Array(fs.readFileSync(path.join(dir, coverage.grid.file))));
const sample = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as [number, number, string][];
const idToRegion = new Map(geo.regions.map((r) => [r.id, r]));

let wrongRegion = 0, wrongCountryNoHint = 0, missNoHint = 0, missWithHint = 0;
const examples: string[] = [];
const t0 = performance.now();
for (const [lat, lng, id] of sample) {
  const truth = idToRegion.get(id)!;
  const withHint = geo.locate(lat, lng, truth.cc);
  if (withHint < 0) missWithHint++;
  else if (geo.regions[withHint].id !== id) {
    wrongRegion++;
    if (examples.length < 12 && wrongRegion % 97 === 0) examples.push(`${lat},${lng}: ${truth.name} (${truth.cc}) -> ${geo.regions[withHint].name}`);
  }
  const noHint = geo.locate(lat, lng);
  if (noHint < 0) missNoHint++;
  else if (geo.regions[noHint].cc !== truth.cc) wrongCountryNoHint++;
}
const ms = performance.now() - t0;
const pct = (n: number) => `${((100 * n) / sample.length).toFixed(3)}%`;
console.log(`${sample.length.toLocaleString()} sampled Street View locations, ${(ms / sample.length / 2 * 1000).toFixed(1)} µs per lookup`);
console.log(`with the country known:   wrong region ${pct(wrongRegion)}, not found ${pct(missWithHint)}`);
console.log(`without a country hint:   wrong country ${pct(wrongCountryNoHint)}, not found ${pct(missNoHint)}`);
console.log(examples.join('\n'));
