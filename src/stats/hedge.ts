/**
 * Where to click when you know the country but not the region: the "hedge".
 *
 * A round on the World map is worth 5000 * exp(-d / L) points for a guess d km away, with
 * L = 1491.7 km. Given where a country's locations fall (weighted points), the best hedge is the
 * spot that maximises the expected score. It sits near the middle of the coverage but leans
 * towards dense coverage and is barely pulled by far-off outliers, because a miss of 3,000 km
 * and a miss of 6,000 km both score close to nothing.
 *
 * In team duels a team's round score is its best guess, so two teammates should split the
 * country: the best pair of pins maximises the expected value of the better of the two scores.
 *
 * Both problems are smooth but not concave, so the optimiser starts from many candidate spots
 * and polishes each with a pattern search, keeping the best result. Deterministic for a given
 * input.
 */

export interface WeightedPoint {
  lat: number;
  lng: number;
  /** Relative weight: how many locations this point stands for. */
  w: number;
}

export interface Pin {
  lat: number;
  lng: number;
}

export interface HedgeResult {
  pins: Pin[];
  /** Expected round score (0 to 5000) when guessing at the best pin for every location. */
  expected: number;
  /** Share of the weight for which each pin is the closer one. */
  shares: number[];
  /** Distance (km) from each location to its closest pin: median, 90th percentile, maximum. */
  miss: [number, number, number];
}

export const WORLD_SCORE_SCALE_KM = 1491.6862;
const EARTH_RADIUS_KM = 6371.0088;
const RAD = Math.PI / 180;
const KM_PER_DEG = 111.195;

/** Score for a guess `km` away on a map whose decay length is `scaleKm`. */
export const roundScore = (km: number, scaleKm = WORLD_SCORE_SCALE_KM): number => 5000 * Math.exp(-km / scaleKm);

/** Points in a form that makes distance evaluations cheap. Weights are normalised to sum to 1. */
class PointSet {
  readonly n: number;
  readonly lat: Float64Array;
  readonly lng: Float64Array;
  readonly cos: Float64Array;
  readonly w: Float64Array;

  constructor(points: WeightedPoint[]) {
    const kept = points.filter((p) => p.w > 0 && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    this.n = kept.length;
    this.lat = new Float64Array(this.n);
    this.lng = new Float64Array(this.n);
    this.cos = new Float64Array(this.n);
    this.w = new Float64Array(this.n);
    const total = kept.reduce((s, p) => s + p.w, 0);
    kept.forEach((p, i) => {
      this.lat[i] = p.lat * RAD;
      this.lng[i] = p.lng * RAD;
      this.cos[i] = Math.cos(p.lat * RAD);
      this.w[i] = p.w / total;
    });
  }

  /** Great-circle distance in km from a pin to point i. */
  distance(latRad: number, lngRad: number, cosLat: number, i: number): number {
    const dLat = this.lat[i] - latRad;
    const dLng = this.lng[i] - lngRad;
    const a = Math.sin(dLat / 2) ** 2 + cosLat * this.cos[i] * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Distances from a pin to every point. */
  distances(pin: Pin, out = new Float64Array(this.n)): Float64Array {
    const la = pin.lat * RAD, lo = pin.lng * RAD, c = Math.cos(la);
    for (let i = 0; i < this.n; i++) out[i] = this.distance(la, lo, c, i);
    return out;
  }
}

/** Expected score of a candidate pin, given each point's distance to the other pins (or Infinity). */
function evaluate(set: PointSet, pin: Pin, other: Float64Array | null, scaleKm: number, sample?: Int32Array): number {
  const la = pin.lat * RAD, lo = pin.lng * RAD, c = Math.cos(la);
  let sum = 0;
  if (sample) {
    let wsum = 0;
    for (let k = 0; k < sample.length; k++) {
      const i = sample[k];
      let d = set.distance(la, lo, c, i);
      if (other && other[i] < d) d = other[i];
      sum += set.w[i] * Math.exp(-d / scaleKm);
      wsum += set.w[i];
    }
    return (5000 * sum) / wsum;
  }
  for (let i = 0; i < set.n; i++) {
    let d = set.distance(la, lo, c, i);
    if (other && other[i] < d) d = other[i];
    sum += set.w[i] * Math.exp(-d / scaleKm);
  }
  return 5000 * sum;
}

const wrapLng = (lng: number): number => ((((lng + 180) % 360) + 360) % 360) - 180;

function step(pin: Pin, km: number, bearing: number): Pin {
  const lat = Math.max(-89.5, Math.min(89.5, pin.lat + (km * Math.cos(bearing)) / KM_PER_DEG));
  const lng = wrapLng(pin.lng + (km * Math.sin(bearing)) / (KM_PER_DEG * Math.max(0.05, Math.cos(pin.lat * RAD))));
  return { lat, lng };
}

const BEARINGS = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);

/** Best-improvement pattern search for one pin with the others fixed. Returns the improved pin and its value. */
function polish(set: PointSet, start: Pin, other: Float64Array | null, scaleKm: number, startKm: number, minKm = 0.2): { pin: Pin; value: number } {
  let pin = start;
  let value = evaluate(set, pin, other, scaleKm);
  let km = startKm;
  for (let guard = 0; km >= minKm && guard < 400; guard++) {
    let bestPin: Pin | null = null, bestValue = value;
    for (const b of BEARINGS) {
      const candidate = step(pin, km, b);
      const v = evaluate(set, candidate, other, scaleKm);
      if (v > bestValue + 1e-9) { bestValue = v; bestPin = candidate; }
    }
    if (bestPin) { pin = bestPin; value = bestValue; }
    else km /= 2;
  }
  return { pin, value };
}

/** Small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Indices drawn in proportion to weight (with replacement, duplicates removed). */
function weightedSample(set: PointSet, count: number, rand: () => number): Int32Array {
  if (set.n <= count) return Int32Array.from({ length: set.n }, (_, i) => i);
  const cumulative = new Float64Array(set.n);
  let acc = 0;
  for (let i = 0; i < set.n; i++) { acc += set.w[i]; cumulative[i] = acc; }
  const picked = new Set<number>();
  for (let k = 0; k < count * 3 && picked.size < count; k++) {
    const r = rand() * acc;
    let lo = 0, hi = set.n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1; else hi = mid;
    }
    picked.add(lo);
  }
  return Int32Array.from([...picked].sort((a, b) => a - b));
}

/** Weighted mean position, computed on the unit sphere (safe across the antimeridian). */
function centroid(set: PointSet): Pin {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < set.n; i++) {
    x += set.w[i] * set.cos[i] * Math.cos(set.lng[i]);
    y += set.w[i] * set.cos[i] * Math.sin(set.lng[i]);
    z += set.w[i] * Math.sin(set.lat[i]);
  }
  return { lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lng: Math.atan2(y, x) / RAD };
}

/** Extent of the points in km (used to size the first search step). */
function spread(set: PointSet, centre: Pin): number {
  const d = set.distances(centre);
  let s = 0;
  for (let i = 0; i < set.n; i++) s += set.w[i] * d[i];
  return s;
}

function summarise(set: PointSet, pins: Pin[], scaleKm: number): HedgeResult {
  const all = pins.map((p) => set.distances(p));
  const nearest = new Float64Array(set.n);
  const shares = pins.map(() => 0);
  let sum = 0;
  for (let i = 0; i < set.n; i++) {
    let best = 0;
    for (let k = 1; k < pins.length; k++) if (all[k][i] < all[best][i]) best = k;
    nearest[i] = all[best][i];
    shares[best] += set.w[i];
    sum += set.w[i] * Math.exp(-nearest[i] / scaleKm);
  }
  const order = Array.from(nearest.keys()).sort((a, b) => nearest[a] - nearest[b]);
  const quantile = (p: number): number => {
    let acc = 0;
    for (const i of order) {
      acc += set.w[i];
      if (acc >= p - 1e-12) return nearest[i];
    }
    return nearest[order[order.length - 1]] ?? 0;
  };
  return {
    pins: pins.map((p) => ({ lat: +p.lat.toFixed(4), lng: +p.lng.toFixed(4) })),
    expected: 5000 * sum,
    shares,
    miss: [quantile(0.5), quantile(0.9), set.n ? nearest[order[order.length - 1]] : 0],
  };
}

export interface HedgeOptions {
  /** Decay length of the score (km). Defaults to the World map's. */
  scaleKm?: number;
  /** Candidate starting spots to screen. */
  candidates?: number;
  seed?: number;
}

/** The single spot with the highest expected score. */
export function bestSoloHedge(points: WeightedPoint[], options: HedgeOptions = {}): HedgeResult {
  const set = new PointSet(points);
  const scaleKm = options.scaleKm ?? WORLD_SCORE_SCALE_KM;
  if (set.n === 0) return { pins: [], expected: 0, shares: [], miss: [0, 0, 0] };
  const pin = soloPin(set, scaleKm, options);
  return summarise(set, [pin], scaleKm);
}

function soloPin(set: PointSet, scaleKm: number, options: HedgeOptions): Pin {
  const rand = random(options.seed ?? 1);
  const centre = centroid(set);
  const startKm = Math.max(2, Math.min(400, spread(set, centre) / 2));
  // Screen candidates (the weighted centre plus locations drawn by weight) on a sample, then
  // polish the most promising few on the full set.
  const sample = weightedSample(set, 2500, rand);
  const candidateIdx = weightedSample(set, options.candidates ?? 300, rand);
  const candidates: Pin[] = [centre, ...Array.from(candidateIdx, (i) => ({ lat: set.lat[i] / RAD, lng: set.lng[i] / RAD }))];
  const screened = candidates
    .map((pin) => ({ pin, v: evaluate(set, pin, null, scaleKm, sample) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 4);
  let best = { pin: centre, value: -Infinity };
  for (const { pin } of screened) {
    const result = polish(set, pin, null, scaleKm, startKm);
    if (result.value > best.value) best = result;
  }
  return best.pin;
}

/**
 * The pair of spots with the highest expected value of the better score: where two teammates
 * should click. The first pin returned covers the larger share of locations.
 */
export function bestTeamHedge(points: WeightedPoint[], options: HedgeOptions = {}): HedgeResult {
  const set = new PointSet(points);
  const scaleKm = options.scaleKm ?? WORLD_SCORE_SCALE_KM;
  if (set.n === 0) return { pins: [], expected: 0, shares: [], miss: [0, 0, 0] };
  const rand = random((options.seed ?? 1) + 101);
  const solo = soloPin(set, scaleKm, options);
  const centre = centroid(set);
  const startKm = Math.max(2, Math.min(400, spread(set, centre) / 2));
  const sample = weightedSample(set, 2500, rand);
  const candidateIdx = weightedSample(set, options.candidates ?? 300, rand);
  const candidates = Array.from(candidateIdx, (i) => ({ lat: set.lat[i] / RAD, lng: set.lng[i] / RAD }));

  const starts: [Pin, Pin][] = [];
  // 1. Keep the solo pin and add the best partner for it.
  const soloDistances = set.distances(solo);
  const partners = candidates
    .map((pin) => ({ pin, v: evaluate(set, pin, soloDistances, scaleKm, sample) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3);
  for (const p of partners) starts.push([solo, p.pin]);
  // 2. Spread-out seeds: the second pin drawn where the first one scores worst (k-means++ style).
  for (let s = 0; s < 4 && candidates.length > 1; s++) {
    const a = candidates[Math.floor(rand() * candidates.length)];
    const da = set.distances(a);
    let total = 0;
    const loss = candidateIdx.length ? Array.from(candidateIdx, (i) => { const l = 1 - Math.exp(-da[i] / scaleKm); total += l; return l; }) : [];
    let r = rand() * total, pick = 0;
    for (; pick < loss.length - 1 && r > loss[pick]; pick++) r -= loss[pick];
    starts.push([a, candidates[pick]]);
  }

  let best: { pins: [Pin, Pin]; value: number } = { pins: [solo, solo], value: -Infinity };
  for (const [a0, b0] of starts) {
    let a = a0, b = b0, value = -Infinity;
    // Coordinate ascent: polish each pin with the other fixed until neither moves.
    for (let round = 0, km = startKm; round < 12; round++, km = Math.max(4, km / 2)) {
      const ra = polish(set, a, set.distances(b), scaleKm, km);
      a = ra.pin;
      const rb = polish(set, b, set.distances(a), scaleKm, km);
      b = rb.pin;
      if (rb.value <= value + 1e-6) { value = Math.max(value, rb.value); break; }
      value = rb.value;
    }
    if (value > best.value) best = { pins: [a, b], value };
  }
  const result = summarise(set, best.pins, scaleKm);
  if (result.shares[1] > result.shares[0]) {
    return summarise(set, [best.pins[1], best.pins[0]], scaleKm);
  }
  return result;
}

/** Expected score for given pins (team: best of them). */
export function expectedScore(points: WeightedPoint[], pins: Pin[], scaleKm = WORLD_SCORE_SCALE_KM): number {
  const set = new PointSet(points);
  return pins.length && set.n ? summarise(set, pins, scaleKm).expected : 0;
}

/** Compass word for the direction from one pin to another ("north-west"). */
export function compass(from: Pin, to: Pin): string {
  const dLng = wrapLng(to.lng - from.lng) * Math.cos(((from.lat + to.lat) / 2) * RAD);
  const dLat = to.lat - from.lat;
  const angle = (Math.atan2(dLng, dLat) / RAD + 360) % 360;
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(angle / 45) % 8];
}
