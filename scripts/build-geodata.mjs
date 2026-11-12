#!/usr/bin/env node
/**
 * Builds the static geodata the app ships with:
 *
 *   public/data/regions.topo.json   admin-1 regions of the world (simplified TopoJSON)
 *   public/data/coverage.json       Street View coverage statistics per country and region
 *   public/data/coverage-grid.bin   0.25 degree bitmap of where Street View exists
 *
 * Sources (both public):
 *   - Natural Earth 1:10m admin-1 states/provinces (public domain)
 *       https://github.com/nvkelso/natural-earth-vector
 *   - "coverage date maps" by emily: Street View locations for every country and
 *     dependency on Google Maps, refreshed roughly monthly
 *       https://geo.emily.bz/coverage-dates
 *
 * Only aggregates derived from the coverage points are written to the repository;
 * the raw points are never redistributed.
 *
 * Usage:
 *   node scripts/build-geodata.mjs [--download] [--cache <dir>] [--out <dir>]
 *
 * With --download the inputs are fetched into the cache directory first (about
 * 700 MB, one file at a time). Without it the script expects them to be there:
 *   <cache>/ne/ne_10m_admin_1_states_provinces.geojson
 *   <cache>/coverage/<territory>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topology } from 'topojson-server';
import { presimplify, simplify } from 'topojson-simplify';
import { feature } from 'topojson-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CACHE = path.resolve(opt('--cache', path.join(ROOT, '.cache', 'geodata')));
const OUT = path.resolve(opt('--out', path.join(ROOT, 'public', 'data')));
const NE_DIR = path.resolve(opt('--ne', path.join(CACHE, 'ne')));
const COVERAGE_DIR = path.resolve(opt('--coverage', path.join(CACHE, 'coverage')));

const NE_FILE = 'ne_10m_admin_1_states_provinces.geojson';
const NE_URL = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/${NE_FILE}`;
const COVERAGE_INDEX = 'https://geo.emily.bz/coverage-dates';

/** Grid used to measure coverage. Coarser than the sparsest country's sampling (see README). */
const CELL_DEG = 0.25;
const GRID_COLS = Math.round(360 / CELL_DEG);
const GRID_ROWS = Math.round(180 / CELL_DEG);

const EARTH_RADIUS_KM = 6371.0088;
/** GeoGuessr "World" map: score = 5000 * exp(-10 * d / maxErrorDistance), maxErrorDistance = 14,916.862 km. */
const SCORE_SCALE_KM = 1491.6862;
const RAD = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (compatible; geodata-build)';

async function download(url, file) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.part', buf);
  fs.renameSync(file + '.part', file);
  return buf.length;
}

async function downloadInputs() {
  const neFile = path.join(NE_DIR, NE_FILE);
  if (!fs.existsSync(neFile)) {
    process.stdout.write(`Downloading ${NE_FILE} ... `);
    console.log(`${(await download(NE_URL, neFile) / 1e6).toFixed(1)} MB`);
  }
  const res = await fetch(COVERAGE_INDEX, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} for ${COVERAGE_INDEX}`);
  const html = await res.text();
  const files = [...new Set([...html.matchAll(/href="(coverage-dates\/[^"]+\.json)"/g)].map((m) => m[1]))].sort();
  if (files.length === 0) throw new Error('No coverage files found on the index page - has the site layout changed?');
  console.log(`Coverage index lists ${files.length} territories`);
  for (const rel of files) {
    const file = path.join(COVERAGE_DIR, path.basename(rel));
    if (fs.existsSync(file) && fs.statSync(file).size > 0) continue;
    process.stdout.write(`  ${path.basename(rel)} ... `);
    const bytes = await download(`https://geo.emily.bz/${rel}`, file);
    console.log(`${(bytes / 1e6).toFixed(1)} MB`);
    await new Promise((r) => setTimeout(r, 400)); // one request at a time, with a pause
  }
}

// ---------------------------------------------------------------------------------------------
// Natural Earth: properties
// ---------------------------------------------------------------------------------------------

const FRENCH_OVERSEAS = { 'FR-GF': 'GF', 'FR-MQ': 'MQ', 'FR-GP': 'GP', 'FR-RE': 'RE', 'FR-YT': 'YT' };

/** ISO 3166-1 alpha-2 code for a Natural Earth admin-1 feature, matching what GeoGuessr reports. */
function countryCode(p) {
  const sub = p.iso_3166_2 || '';
  if (FRENCH_OVERSEAS[sub]) return FRENCH_OVERSEAS[sub];
  if (sub === 'NO-21' || sub === 'NO-22') return 'SJ'; // Svalbard and Jan Mayen
  if (/^NL-BQ/.test(sub)) return 'BQ'; // Caribbean Netherlands
  const a2 = String(p.iso_a2 || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(a2)) return a2;
  switch (p.adm0_a3) {
    case 'CYN': // Northern Cyprus
    case 'ESB': // Dhekelia
    case 'WSB': // Akrotiri
      return 'CY';
    case 'SOL':
      return 'SO';
    case 'KAS':
      return 'IN';
    case 'KAB':
      return 'KZ';
    case 'USG':
      return 'CU';
    case 'CSI':
      return 'AU';
    case 'CLP':
      return 'FR';
    case 'IOA':
      return /christmas/i.test(p.name || '') ? 'CX' : 'CC';
    default:
      return 'XX';
  }
}

/** Names for codes that Natural Earth files under their parent state. */
const NAME_OVERRIDES = {
  GF: 'French Guiana', MQ: 'Martinique', GP: 'Guadeloupe', RE: 'Réunion', YT: 'Mayotte',
  SJ: 'Svalbard and Jan Mayen', BQ: 'Caribbean Netherlands', CX: 'Christmas Island',
  CC: 'Cocos (Keeling) Islands', XX: 'Other', PS: 'Palestine', MK: 'North Macedonia', CZ: 'Czechia',
  RS: 'Serbia', TZ: 'Tanzania', US: 'United States', HK: 'Hong Kong', MO: 'Macau', BS: 'Bahamas',
};

function regionName(p) {
  return p.name_en || p.name || p.gn_name || p.woe_name || `${p.admin} (other)`;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

/** Polygons of a GeoJSON geometry as arrays of rings. */
function polygonsOf(geometry) {
  if (!geometry) return [];
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
}

/** Area of a ring in km², via the (area-preserving) Lambert cylindrical projection. */
function ringAreaKm2(ring) {
  let sum = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const x1 = ring[i][0] * RAD, y1 = Math.sin(ring[i][1] * RAD);
    const x2 = ring[i + 1][0] * RAD, y2 = Math.sin(ring[i + 1][1] * RAD);
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2 * EARTH_RADIUS_KM * EARTH_RADIUS_KM;
}

function geometryAreaKm2(geometry) {
  let area = 0;
  for (const poly of polygonsOf(geometry)) {
    poly.forEach((ring, i) => { area += (i === 0 ? 1 : -1) * ringAreaKm2(ring); });
  }
  return Math.max(0, area);
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * RAD, dLng = (lng2 - lng1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Point-in-polygon index for one feature. Edges are bucketed by latitude band so that a
 * ray cast only looks at the handful of edges near the query latitude.
 */
const BAND_DEG = 0.25;
class FeatureIndex {
  constructor(geometry) {
    this.minX = Infinity; this.minY = Infinity; this.maxX = -Infinity; this.maxY = -Infinity;
    const bands = new Map();
    for (const poly of polygonsOf(geometry)) {
      for (const ring of poly) {
        for (let i = 0, n = ring.length - 1; i < n; i++) {
          const x1 = ring[i][0], y1 = ring[i][1], x2 = ring[i + 1][0], y2 = ring[i + 1][1];
          if (x1 < this.minX) this.minX = x1; if (x1 > this.maxX) this.maxX = x1;
          if (y1 < this.minY) this.minY = y1; if (y1 > this.maxY) this.maxY = y1;
          const b0 = Math.floor(Math.min(y1, y2) / BAND_DEG), b1 = Math.floor(Math.max(y1, y2) / BAND_DEG);
          for (let b = b0; b <= b1; b++) {
            let arr = bands.get(b);
            if (!arr) bands.set(b, arr = []);
            arr.push(x1, y1, x2, y2);
          }
        }
      }
    }
    this.bands = new Map();
    for (const [b, arr] of bands) this.bands.set(b, Float64Array.from(arr));
  }

  contains(x, y) {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return false;
    const edges = this.bands.get(Math.floor(y / BAND_DEG));
    if (!edges) return false;
    let inside = false;
    for (let i = 0; i < edges.length; i += 4) {
      const y1 = edges[i + 1], y2 = edges[i + 3];
      if ((y1 > y) !== (y2 > y)) {
        const x1 = edges[i], x2 = edges[i + 2];
        if (x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
      }
    }
    return inside;
  }

  /** Approximate distance in km from a point to the nearest edge (searching nearby latitude bands). */
  distanceKm(x, y, reachDeg) {
    if (x < this.minX - reachDeg * 2 || x > this.maxX + reachDeg * 2 || y < this.minY - reachDeg || y > this.maxY + reachDeg) return Infinity;
    const kx = Math.cos(y * RAD) * 111.195, ky = 111.195;
    let best = Infinity;
    const b0 = Math.floor((y - reachDeg) / BAND_DEG), b1 = Math.floor((y + reachDeg) / BAND_DEG);
    for (let b = b0; b <= b1; b++) {
      const edges = this.bands.get(b);
      if (!edges) continue;
      for (let i = 0; i < edges.length; i += 4) {
        const ax = (edges[i] - x) * kx, ay = (edges[i + 1] - y) * ky;
        const bx = (edges[i + 2] - x) * kx, by = (edges[i + 3] - y) * ky;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + t * dx, py = ay + t * dy;
        const d2 = px * px + py * py;
        if (d2 < best) best = d2;
      }
    }
    return Math.sqrt(best);
  }
}

function quantiles(sorted, probs) {
  if (sorted.length === 0) return probs.map(() => 0);
  return probs.map((p) => {
    const pos = p * (sorted.length - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  });
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  if (flag('--download')) await downloadInputs();

  const neFile = path.join(NE_DIR, NE_FILE);
  if (!fs.existsSync(neFile)) throw new Error(`Missing ${neFile}. Run with --download or pass --ne <dir>.`);
  if (!fs.existsSync(COVERAGE_DIR)) throw new Error(`Missing ${COVERAGE_DIR}. Run with --download or pass --coverage <dir>.`);

  console.time('total');
  const ne = JSON.parse(fs.readFileSync(neFile, 'utf8'));
  const features = ne.features.filter((f) => f.geometry);
  console.log(`Natural Earth admin-1: ${features.length} regions`);

  const regions = features.map((f, index) => ({
    index,
    id: f.properties.adm1_code,
    name: regionName(f.properties),
    cc: countryCode(f.properties),
    countryName: f.properties.admin,
    areaKm2: geometryAreaKm2(f.geometry),
    geometry: f.geometry,
    fi: new FeatureIndex(f.geometry),
    cells: new Set(),
    points: 0,
  }));

  // 1 degree lookup grid: which regions' bounding boxes touch each cell.
  const lookup = new Map();
  for (const r of regions) {
    for (let gy = Math.floor(r.fi.minY); gy <= Math.floor(r.fi.maxY); gy++) {
      for (let gx = Math.floor(r.fi.minX); gx <= Math.floor(r.fi.maxX); gx++) {
        const key = gy * 1000 + gx;
        let arr = lookup.get(key);
        if (!arr) lookup.set(key, arr = []);
        arr.push(r.index);
      }
    }
  }

  const nearCache = new Map();
  const NEAR_REACH_DEG = 0.3; // about 33 km: coast roads, piers and islets missing from 1:10m outlines
  function locate(lng, lat) {
    const gy = Math.floor(lat), gx = Math.floor(lng);
    const candidates = lookup.get(gy * 1000 + gx);
    if (candidates) {
      for (const idx of candidates) if (regions[idx].fi.contains(lng, lat)) return idx;
    }
    const key = Math.round(lat * 50) * 100000 + Math.round(lng * 50);
    const cached = nearCache.get(key);
    if (cached !== undefined) return cached;
    let best = -1, bestD = 35;
    const seen = new Set();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = lookup.get((gy + dy) * 1000 + gx + dx);
        if (!arr) continue;
        for (const idx of arr) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          const d = regions[idx].fi.distanceKm(lng, lat, NEAR_REACH_DEG);
          if (d < bestD) { bestD = d; best = idx; }
        }
      }
    }
    nearCache.set(key, best);
    return best;
  }

  // ---- Coverage points -> regions and grid cells -------------------------------------------
  // The assignment is cached so the (fast) topology step can be re-run on its own.
  const assignmentFile = path.join(CACHE, 'assignment.json');
  let grid = new Uint8Array((GRID_COLS * GRID_ROWS) / 8);
  let totalPoints = 0, unassigned = 0, nearAssigned = 0, territories = 0;
  let newest = '';
  if (flag('--reuse-assignment') && fs.existsSync(assignmentFile)) {
    const saved = JSON.parse(fs.readFileSync(assignmentFile, 'utf8'));
    ({ totalPoints, unassigned, nearAssigned, territories, newest } = saved);
    grid = Uint8Array.from(Buffer.from(saved.grid, 'base64'));
    saved.regions.forEach(([points, cells], i) => { regions[i].points = points; regions[i].cells = new Set(cells); });
    console.log(`  reused cached assignment (${totalPoints.toLocaleString()} points)`);
  } else {
    const files = fs.readdirSync(COVERAGE_DIR).filter((f) => f.endsWith('.json')).sort();
    territories = files.length;
    // Optional: keep every Nth point with its true region, to measure what simplification costs.
    const sample = opt('--sample-out', null) ? [] : null;
    const SAMPLE_EVERY = 40;
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(COVERAGE_DIR, file), 'utf8'));
      const points = data.customCoordinates || [];
      for (const p of points) {
        const lat = p.lat, lng = p.lng;
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
        totalPoints++;
        const tags = p.extra && p.extra.tags;
        if (tags) for (const t of tags) if (/^\d{4}-\d{2}$/.test(t) && t > newest) newest = t;
        const row = Math.min(GRID_ROWS - 1, Math.floor((lat + 90) / CELL_DEG));
        const col = Math.min(GRID_COLS - 1, Math.floor((lng + 180) / CELL_DEG));
        const cell = row * GRID_COLS + col;
        grid[cell >> 3] |= 1 << (cell & 7);
        const before = nearCache.size;
        const idx = locate(lng, lat);
        if (idx < 0) { unassigned++; continue; }
        if (nearCache.size !== before) nearAssigned++;
        const r = regions[idx];
        r.points++;
        r.cells.add(cell);
        if (sample && totalPoints % SAMPLE_EVERY === 0) sample.push([+lat.toFixed(5), +lng.toFixed(5), r.id]);
      }
      if (process.stdout.isTTY) process.stdout.write(`\r  coverage: ${file.padEnd(48)} ${totalPoints.toLocaleString()} points`);
    }
    if (process.stdout.isTTY) process.stdout.write('\n');
    fs.mkdirSync(CACHE, { recursive: true });
    if (sample) fs.writeFileSync(path.resolve(opt('--sample-out', '')), JSON.stringify(sample));
    fs.writeFileSync(assignmentFile, JSON.stringify({
      totalPoints, unassigned, nearAssigned, territories, newest,
      grid: Buffer.from(grid).toString('base64'),
      regions: regions.map((r) => [r.points, [...r.cells]]),
    }));
  }
  console.log(`  ${territories} territories, ${totalPoints.toLocaleString()} points, ${unassigned.toLocaleString()} outside every region`);
  console.log(`  newest capture tag: ${newest}`);

  const cellCenter = (cell) => {
    const row = Math.floor(cell / GRID_COLS), col = cell % GRID_COLS;
    return [-90 + (row + 0.5) * CELL_DEG, -180 + (col + 0.5) * CELL_DEG];
  };
  const cellAreaKm2 = (cell) => {
    const row = Math.floor(cell / GRID_COLS);
    const lat0 = (-90 + row * CELL_DEG) * RAD, lat1 = (-90 + (row + 1) * CELL_DEG) * RAD;
    return EARTH_RADIUS_KM * EARTH_RADIUS_KM * CELL_DEG * RAD * (Math.sin(lat1) - Math.sin(lat0));
  };

  // ---- Per country: footprint, best single guess, distances -------------------------------
  const byCountry = new Map();
  for (const r of regions) {
    let c = byCountry.get(r.cc);
    if (!c) byCountry.set(r.cc, c = { cc: r.cc, nameArea: new Map(), regions: [], areaKm2: 0, cells: new Set(), points: 0 });
    c.nameArea.set(r.countryName, (c.nameArea.get(r.countryName) || 0) + r.areaKm2);
    c.regions.push(r);
    c.areaKm2 += r.areaKm2;
    c.points += r.points;
    for (const cell of r.cells) c.cells.add(cell);
  }

  const countriesOut = {};
  const regionsOut = {};
  const names = {};
  const QUANT = [0, 0.25, 0.5, 0.75, 1];
  for (const c of [...byCountry.values()].sort((a, b) => a.cc.localeCompare(b.cc))) {
    // A code can gather several Natural Earth units (Cyprus and Northern Cyprus, say): the largest names it.
    names[c.cc] = NAME_OVERRIDES[c.cc] || [...c.nameArea.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (c.cells.size === 0) continue;
    const cells = [...c.cells].sort((a, b) => a - b);
    const centers = cells.map(cellCenter);
    const weights = cells.map(cellAreaKm2);
    const coveredArea = weights.reduce((a, b) => a + b, 0);

    // Best single guess: the covered cell that maximises the expected score over the country's
    // coverage. This is what "knowing the country and nothing else" is worth.
    const candidateStep = Math.max(1, Math.floor(cells.length / 600));
    const sampleStep = Math.max(1, Math.floor(cells.length / 4000));
    let bestIdx = 0, bestValue = -1;
    for (let i = 0; i < cells.length; i += candidateStep) {
      let sum = 0, wsum = 0;
      for (let j = 0; j < cells.length; j += sampleStep) {
        const d = haversineKm(centers[i][0], centers[i][1], centers[j][0], centers[j][1]);
        sum += weights[j] * Math.exp(-d / SCORE_SCALE_KM);
        wsum += weights[j];
      }
      if (sum / wsum > bestValue) { bestValue = sum / wsum; bestIdx = i; }
    }
    const guess = centers[bestIdx];
    const distanceOf = new Map();
    let scoreSum = 0;
    for (let j = 0; j < cells.length; j++) {
      const d = haversineKm(guess[0], guess[1], centers[j][0], centers[j][1]);
      distanceOf.set(cells[j], d);
      scoreSum += weights[j] * 5000 * Math.exp(-d / SCORE_SCALE_KM);
    }
    const sortedAll = [...distanceOf.values()].sort((a, b) => a - b);

    countriesOut[c.cc] = {
      cells: cells.length,
      area: Math.round(c.areaKm2),
      cov: +Math.min(1, coveredArea / Math.max(1, c.areaKm2)).toFixed(3),
      guess: [+guess[0].toFixed(2), +guess[1].toFixed(2)],
      base: Math.round(scoreSum / coveredArea),
      d: quantiles(sortedAll, QUANT).map(Math.round),
    };

    for (const r of c.regions) {
      if (r.cells.size === 0) continue;
      const ds = [...r.cells].map((cell) => distanceOf.get(cell)).sort((a, b) => a - b);
      const covered = [...r.cells].reduce((a, cell) => a + cellAreaKm2(cell), 0);
      regionsOut[r.id] = [
        r.cells.size,
        Math.round(100 * Math.min(1, covered / Math.max(1, r.areaKm2))),
        ...quantiles(ds, QUANT).map(Math.round),
      ];
    }
  }

  // ---- Simplified topology for the app ----------------------------------------------------
  console.log('Building topology ...');
  const collection = {
    type: 'FeatureCollection',
    features: regions.map((r) => ({ type: 'Feature', id: r.id, properties: { n: r.name, c: r.cc }, geometry: r.geometry })),
  };
  // presimplify returns a new, de-quantised topology whose arc points carry a weight.
  const weighted = presimplify(topology({ regions: collection }, 1e6));

  // Never simplify the outline of small regions: micro-states and island territories matter in
  // GeoGuessr and would otherwise collapse to nothing.
  const SMALL_KM2 = 2500;
  const protect = (arcs) => {
    for (const a of arcs) {
      if (Array.isArray(a)) protect(a);
      else for (const point of weighted.arcs[a < 0 ? ~a : a]) point[2] = Infinity;
    }
  };
  weighted.objects.regions.geometries.forEach((g, i) => {
    if (regions[i].areaKm2 < SMALL_KM2 && g.arcs) protect(g.arcs);
  });

  // Borders between two regions decide which region a location belongs to; coastlines only
  // matter for looks. So shared borders are given extra weight and survive simplification longer.
  const arcUse = new Map();
  const countArcs = (arcs, owner) => {
    for (const a of arcs) {
      if (Array.isArray(a)) countArcs(a, owner);
      else {
        const key = a < 0 ? ~a : a;
        let owners = arcUse.get(key);
        if (!owners) arcUse.set(key, owners = new Set());
        owners.add(owner);
      }
    }
  };
  weighted.objects.regions.geometries.forEach((g, i) => { if (g.arcs) countArcs(g.arcs, i); });
  // Keep a fraction of the points on each kind of line (largest Visvalingam weights first), then
  // rescale the border weights so that a single threshold applies to both.
  const BORDER_DETAIL = Number(opt('--border-detail', '0.3'));
  const COAST_DETAIL = Number(opt('--coast-detail', '0.12'));
  const borderWeights = [], coastWeights = [];
  for (const [key, owners] of arcUse) {
    const target = owners.size >= 2 ? borderWeights : coastWeights;
    for (const point of weighted.arcs[key]) if (Number.isFinite(point[2])) target.push(point[2]);
  }
  const cut = (weights, keep) => {
    if (weights.length === 0 || keep >= 1) return 0;
    weights.sort((a, b) => b - a);
    return Math.max(weights[Math.min(weights.length - 1, Math.floor(keep * weights.length))], 1e-12);
  };

  // Islands are single closed arcs. Simplified like any coast, a small one (Manhattan, say)
  // collapses to a sliver and its locations snap to whatever is nearest. Keep their shape.
  const ISLAND_MIN_KM2 = Number(opt('--island-min', '12'));
  let islands = 0;
  for (const [key, owners] of arcUse) {
    if (owners.size !== 1) continue;
    const arc = weighted.arcs[key];
    const n = arc.length;
    if (n < 4 || arc[0][0] !== arc[n - 1][0] || arc[0][1] !== arc[n - 1][1]) continue;
    if (ringAreaKm2(arc) < ISLAND_MIN_KM2) continue;
    islands++;
    const keep = Math.min(n - 2, Math.max(6, Math.ceil(n * 0.3)));
    const order = arc.map((point, i) => i).filter((i) => i > 0 && i < n - 1).sort((a, b) => arc[b][2] - arc[a][2]);
    for (let k = 0; k < keep; k++) arc[order[k]][2] = Infinity;
  }
  const borderCut = cut(borderWeights, BORDER_DETAIL), coastCut = cut(coastWeights, COAST_DETAIL);
  const minWeight = coastCut;
  for (const [key, owners] of arcUse) {
    if (owners.size < 2) continue;
    for (const point of weighted.arcs[key]) {
      if (Number.isFinite(point[2])) point[2] = borderCut > 0 ? point[2] * (coastCut / borderCut) : Infinity;
    }
  }
  console.log(`  ${islands.toLocaleString()} islands of ${ISLAND_MIN_KM2} km2 or more kept in shape`);
  console.log(`  simplifiable points: ${borderWeights.length.toLocaleString()} on shared borders (keeping ${Math.round(BORDER_DETAIL * 100)}%), ${coastWeights.length.toLocaleString()} on coasts (keeping ${Math.round(COAST_DETAIL * 100)}%)`);
  const simplified = simplify(weighted, minWeight);
  const simple = feature(simplified, simplified.objects.regions);

  // Drop specks (tiny islets) but always keep the largest ring of every region.
  const MIN_RING_KM2 = ISLAND_MIN_KM2;
  for (const f of simple.features) {
    const g = f.geometry;
    if (!g) continue;
    const polys = polygonsOf(g).filter((poly) => poly.length > 0 && poly[0].length >= 4).map((poly) => ({ poly, area: ringAreaKm2(poly[0]) }));
    if (polys.length === 0) { f.geometry = null; continue; }
    const largest = polys.reduce((a, b) => (b.area > a.area ? b : a));
    const kept = polys.filter((p) => p === largest || p.area >= MIN_RING_KM2)
      .map((p) => p.poly.filter((ring, i) => i === 0 || (ring.length >= 4 && ringAreaKm2(ring) >= MIN_RING_KM2)));
    f.geometry = kept.length === 1 ? { type: 'Polygon', coordinates: kept[0] } : { type: 'MultiPolygon', coordinates: kept };
  }
  const finalTopology = topology({ regions: simple }, 1e5);
  delete finalTopology.bbox;

  // ---- Write -----------------------------------------------------------------------------
  fs.mkdirSync(OUT, { recursive: true });
  const topoJson = JSON.stringify(finalTopology);
  fs.writeFileSync(path.join(OUT, 'regions.topo.json'), topoJson);
  fs.writeFileSync(path.join(OUT, 'coverage-grid.bin'), grid);

  const coverage = {
    meta: {
      generated: new Date().toISOString().slice(0, 10),
      newestCapture: newest,
      points: totalPoints,
      territories,
      cellDeg: CELL_DEG,
      scoreScaleKm: SCORE_SCALE_KM,
      sources: [
        { name: 'coverage date maps (emily)', url: 'https://geo.emily.bz/coverage-dates' },
        { name: 'Natural Earth 1:10m admin-1', url: 'https://www.naturalearthdata.com/' },
      ],
      fields: {
        countries: 'cells: covered grid cells; area: km2; cov: share of area in a covered cell; guess: [lat, lng] of the best single guess; base: expected score of that guess; d: distance from the guess to covered cells in km [min, q25, median, q75, max]',
        regions: '[cells, coverage percent of area, then the same five distance quantiles measured from the country guess]',
      },
    },
    grid: { cols: GRID_COLS, rows: GRID_ROWS, cellDeg: CELL_DEG, west: -180, south: -90, file: 'coverage-grid.bin' },
    names,
    countries: countriesOut,
    regions: regionsOut,
  };
  fs.writeFileSync(path.join(OUT, 'coverage.json'), JSON.stringify(coverage));

  // ---- Report ----------------------------------------------------------------------------
  const covered = Object.entries(countriesOut).sort((a, b) => b[1].cells - a[1].cells);
  console.log(`\nCountries/territories with coverage: ${covered.length}; regions with coverage: ${Object.keys(regionsOut).length}`);
  console.log(`Points placed by nearest-region fallback: ~${nearAssigned.toLocaleString()} distinct spots`);
  console.log('Top 25 by footprint:');
  for (const [cc, c] of covered.slice(0, 25)) {
    console.log(`  ${cc}  ${names[cc].padEnd(28)} cells=${String(c.cells).padStart(6)}  cov=${(c.cov * 100).toFixed(0).padStart(3)}%  base=${String(c.base).padStart(4)}  guess=${c.guess.join(',')}  d50=${c.d[2]}km`);
  }
  const size = (f) => `${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)} KB`;
  console.log(`\nWrote regions.topo.json (${size('regions.topo.json')}, ${finalTopology.arcs.length} arcs), coverage.json (${size('coverage.json')}), coverage-grid.bin (${size('coverage-grid.bin')})`);
  console.timeEnd('total');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
