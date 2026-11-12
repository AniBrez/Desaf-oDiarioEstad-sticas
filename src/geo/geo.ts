import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { EARTH_CIRCUMFERENCE_KM, mercatorX, mercatorY } from './mercator';

/** Shape of public/data/coverage.json (written by scripts/build-geodata.mjs). */
export interface CoverageFile {
  meta: {
    generated: string;
    newestCapture: string;
    points: number;
    territories: number;
    cellDeg: number;
    scoreScaleKm: number;
    sources: { name: string; url: string }[];
  };
  grid: { cols: number; rows: number; cellDeg: number; west: number; south: number; file: string };
  names: Record<string, string>;
  countries: Record<string, { cells: number; area: number; cov: number; guess: [number, number]; base: number; d: number[] }>;
  /** [cells, coverage percent, dMin, d25, d50, d75, dMax] */
  regions: Record<string, number[]>;
}

export interface Region {
  idx: number;
  id: string;
  name: string;
  /** Upper-case ISO 3166-1 alpha-2. */
  cc: string;
  /** Polygons -> rings -> flat [x0, y0, x1, y1, ...] in normalised Mercator coordinates. */
  polygons: Float64Array[][];
  /** [minX, minY, maxX, maxY] in normalised Mercator coordinates. */
  bbox: [number, number, number, number];
  /** Covered 0.25 degree cells (0 = no Street View). */
  cells: number;
  /** Share of the area that lies in a covered cell, 0-100. */
  covPct: number;
  /** Distance quantiles (km) from the country's best single guess to this region's coverage. */
  dq: number[] | null;
}

export interface Country {
  cc: string;
  name: string;
  regions: number[];
  bbox: [number, number, number, number];
  cells: number;
  areaKm2: number;
  /** Share of the area that lies in a covered cell, 0-1. */
  cov: number;
  /** Best single guess for the country: [lat, lng]. */
  guess: [number, number] | null;
  /** Expected score of always guessing that point. */
  base: number | null;
  dq: number[] | null;
}

export interface CoverageGrid {
  cols: number;
  rows: number;
  cellDeg: number;
  bits: Uint8Array;
  /** Number of covered cells. */
  count: number;
}

export interface Geo {
  regions: Region[];
  countries: Map<string, Country>;
  topology: Topology;
  grid: CoverageGrid;
  meta: CoverageFile['meta'];
  /** Region containing a point, or -1. A country hint settles border cases and coastal misses. */
  locate(lat: number, lng: number, ccHint?: string | null): number;
  /** Country containing a point, or null (open sea). */
  locateCountry(lat: number, lng: number): string | null;
  isCovered(lat: number, lng: number): boolean;
  /** Index of the coverage cell a point falls in at a coarser resolution (multiples of the grid). */
  coarseCell(lat: number, lng: number, factor: number): number;
  /** Covered cells at a coarser resolution. */
  coarseCovered(factor: number): Set<number>;
}

const INDEX_SIZE = 256;

let displayNames: Intl.DisplayNames | null | undefined;
/** Country name for a code: the browser's own names where available, Natural Earth otherwise. */
export function countryName(cc: string, fallback?: string): string {
  if (displayNames === undefined) {
    try { displayNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { displayNames = null; }
  }
  try {
    const name = displayNames?.of(cc);
    if (name && name !== cc) return name;
  } catch { /* unknown code */ }
  return fallback ?? cc;
}

function ringContains(ring: Float64Array, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const yi = ring[i + 1], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ring[i] + ((y - yi) * (ring[j] - ring[i])) / (yj - yi)) inside = !inside;
  }
  return inside;
}

export function regionContains(region: Region, x: number, y: number): boolean {
  const b = region.bbox;
  if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
  for (const poly of region.polygons) {
    if (!ringContains(poly[0], x, y)) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) if (ringContains(poly[h], x, y)) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

/** Squared distance (normalised Mercator units) from a point to the outline of a region. */
function distanceSquaredToRegion(region: Region, x: number, y: number): number {
  let best = Infinity;
  for (const poly of region.polygons) {
    for (const ring of poly) {
      for (let i = 0; i + 3 < ring.length; i += 2) {
        const ax = ring[i] - x, ay = ring[i + 1] - y;
        const dx = ring[i + 2] - ring[i], dy = ring[i + 3] - ring[i + 1];
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + t * dx, py = ay + t * dy;
        const d2 = px * px + py * py;
        if (d2 < best) best = d2;
      }
    }
  }
  return best;
}

export function buildGeo(topology: Topology, coverage: CoverageFile, gridBits: Uint8Array): Geo {
  const collection = feature(topology, topology.objects.regions as GeometryCollection<{ n: string; c: string }>);

  const regions: Region[] = collection.features.map((f, idx) => {
    const geometry = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
    const rawPolygons: number[][][][] = !geometry ? [] : geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    const polygons = rawPolygons.map((poly) => poly.map((ring) => {
      const flat = new Float64Array(ring.length * 2);
      for (let i = 0; i < ring.length; i++) {
        const x = mercatorX(ring[i][0]), y = mercatorY(ring[i][1]);
        flat[2 * i] = x; flat[2 * i + 1] = y;
        if (x < bbox[0]) bbox[0] = x; if (x > bbox[2]) bbox[2] = x;
        if (y < bbox[1]) bbox[1] = y; if (y > bbox[3]) bbox[3] = y;
      }
      return flat;
    }));
    const id = String(f.id);
    const stats = coverage.regions[id];
    return {
      idx, id, name: f.properties.n, cc: f.properties.c, polygons, bbox,
      cells: stats ? stats[0] : 0,
      covPct: stats ? stats[1] : 0,
      dq: stats ? stats.slice(2, 7) : null,
    };
  });

  const countries = new Map<string, Country>();
  for (const r of regions) {
    let c = countries.get(r.cc);
    if (!c) {
      const stats = coverage.countries[r.cc];
      c = {
        cc: r.cc,
        name: countryName(r.cc, coverage.names[r.cc]),
        regions: [],
        bbox: [Infinity, Infinity, -Infinity, -Infinity],
        cells: stats?.cells ?? 0,
        areaKm2: stats?.area ?? 0,
        cov: stats?.cov ?? 0,
        guess: stats?.guess ?? null,
        base: stats?.base ?? null,
        dq: stats?.d ?? null,
      };
      countries.set(r.cc, c);
    }
    c.regions.push(r.idx);
    if (r.polygons.length) {
      c.bbox[0] = Math.min(c.bbox[0], r.bbox[0]); c.bbox[1] = Math.min(c.bbox[1], r.bbox[1]);
      c.bbox[2] = Math.max(c.bbox[2], r.bbox[2]); c.bbox[3] = Math.max(c.bbox[3], r.bbox[3]);
    }
  }

  // Uniform lookup grid over the unit square.
  const buckets: number[][] = Array.from({ length: INDEX_SIZE * INDEX_SIZE }, () => []);
  const cellOf = (v: number) => Math.max(0, Math.min(INDEX_SIZE - 1, Math.floor(v * INDEX_SIZE)));
  for (const r of regions) {
    if (!r.polygons.length) continue;
    for (let gy = cellOf(r.bbox[1]); gy <= cellOf(r.bbox[3]); gy++) {
      for (let gx = cellOf(r.bbox[0]); gx <= cellOf(r.bbox[2]); gx++) buckets[gy * INDEX_SIZE + gx].push(r.idx);
    }
  }

  const nearest = (candidates: Iterable<number>, x: number, y: number, maxKm: number, lat: number): number => {
    // Mercator is conformal: a unit of map distance is the same on the ground in every direction.
    const unitsPerKm = 1 / (EARTH_CIRCUMFERENCE_KM * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    let best = -1, bestD2 = (maxKm * unitsPerKm) ** 2;
    for (const idx of candidates) {
      const d2 = distanceSquaredToRegion(regions[idx], x, y);
      if (d2 < bestD2) { bestD2 = d2; best = idx; }
    }
    return best;
  };

  const locate = (lat: number, lng: number, ccHint?: string | null): number => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return -1;
    const x = mercatorX(lng), y = mercatorY(lat);
    const gx = cellOf(x), gy = cellOf(y);
    let hit = -1;
    for (const idx of buckets[gy * INDEX_SIZE + gx]) {
      if (!regionContains(regions[idx], x, y)) continue;
      if (!ccHint || regions[idx].cc === ccHint) return idx;
      if (hit < 0) hit = idx;
    }
    if (ccHint) {
      // The simplified outline put the point in a neighbour (or the sea): snap to the hinted country.
      const country = countries.get(ccHint);
      if (country) {
        const near = nearest(country.regions, x, y, 150, lat);
        if (near >= 0) return near;
      }
      return hit;
    }
    if (hit >= 0) return hit;
    const around = new Set<number>();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = gx + dx, cy = gy + dy;
        if (cx < 0 || cy < 0 || cx >= INDEX_SIZE || cy >= INDEX_SIZE) continue;
        for (const idx of buckets[cy * INDEX_SIZE + cx]) around.add(idx);
      }
    }
    return nearest(around, x, y, 40, lat);
  };

  const cols = coverage.grid.cols, rows = coverage.grid.rows, cellDeg = coverage.grid.cellDeg;
  let count = 0;
  for (let i = 0; i < gridBits.length; i++) {
    let b = gridBits[i];
    while (b) { count += b & 1; b >>= 1; }
  }
  const cellIndex = (lat: number, lng: number): number => {
    const row = Math.max(0, Math.min(rows - 1, Math.floor((lat + 90) / cellDeg)));
    const col = Math.max(0, Math.min(cols - 1, Math.floor((lng + 180) / cellDeg)));
    return row * cols + col;
  };
  const coarseCache = new Map<number, Set<number>>();

  return {
    regions,
    countries,
    topology,
    grid: { cols, rows, cellDeg, bits: gridBits, count },
    meta: coverage.meta,
    locate,
    locateCountry(lat, lng) {
      const idx = locate(lat, lng);
      return idx >= 0 ? regions[idx].cc : null;
    },
    isCovered(lat, lng) {
      const cell = cellIndex(lat, lng);
      return (gridBits[cell >> 3] & (1 << (cell & 7))) !== 0;
    },
    coarseCell(lat, lng, factor) {
      const cell = cellIndex(lat, lng);
      const row = Math.floor(Math.floor(cell / cols) / factor), col = Math.floor((cell % cols) / factor);
      return row * Math.ceil(cols / factor) + col;
    },
    coarseCovered(factor) {
      let set = coarseCache.get(factor);
      if (!set) {
        set = new Set<number>();
        const coarseCols = Math.ceil(cols / factor);
        for (let cell = 0; cell < cols * rows; cell++) {
          if (gridBits[cell >> 3] & (1 << (cell & 7))) {
            set.add(Math.floor(Math.floor(cell / cols) / factor) * coarseCols + Math.floor((cell % cols) / factor));
          }
        }
        coarseCache.set(factor, set);
      }
      return set;
    },
  };
}

let pending: Promise<Geo> | null = null;

/** Fetches and builds the geodata once per page. */
export function loadGeo(): Promise<Geo> {
  if (!pending) {
    const base = `${import.meta.env.BASE_URL}data/`;
    const json = async <T,>(file: string): Promise<T> => {
      const res = await fetch(base + file);
      if (!res.ok) throw new Error(`Could not load ${file} (${res.status})`);
      return res.json() as Promise<T>;
    };
    pending = (async () => {
      const [topology, coverage] = await Promise.all([json<Topology>('regions.topo.json'), json<CoverageFile>('coverage.json')]);
      const res = await fetch(base + coverage.grid.file);
      if (!res.ok) throw new Error(`Could not load ${coverage.grid.file} (${res.status})`);
      return buildGeo(topology, coverage, new Uint8Array(await res.arrayBuffer()));
    })();
    pending.catch(() => { pending = null; });
  }
  return pending;
}
