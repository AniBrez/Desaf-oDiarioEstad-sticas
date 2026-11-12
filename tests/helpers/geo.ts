import fs from 'node:fs';
import path from 'node:path';
import type { Topology } from 'topojson-specification';
import { buildGeo, type CoverageFile, type Geo } from '../../src/geo/geo';

let cached: Geo | null = null;

/** The geodata the app ships, loaded straight from public/data. */
export function loadTestGeo(): Geo {
  if (!cached) {
    const dir = path.resolve(__dirname, '../../public/data');
    const topology = JSON.parse(fs.readFileSync(path.join(dir, 'regions.topo.json'), 'utf8')) as Topology;
    const coverage = JSON.parse(fs.readFileSync(path.join(dir, 'coverage.json'), 'utf8')) as CoverageFile;
    const bits = new Uint8Array(fs.readFileSync(path.join(dir, coverage.grid.file)));
    cached = buildGeo(topology, coverage, bits);
  }
  return cached;
}
