/**
 * Synthetic players for trying the app without a GeoGuessr account (and for tests).
 *
 * Locations are drawn from real Street View coverage, and each demo player follows a simple
 * skill model: recognise the country (better with practice and for countries that come up
 * often), then either narrow down the region or fall back to the country's "default" guess.
 * That gives the statistics something realistic to find.
 */
import type { Geo, Region } from '../geo/geo';
import { regionContains } from '../geo/geo';
import { haversineKm, inverseMercatorX, inverseMercatorY } from '../geo/mercator';
import { EXPORT_FORMAT, EXPORT_VERSION, type ExportChallenge, type ExportFile, type ExportGuess, type ExportResult } from './types';

export interface DemoPlayerSpec {
  id: string;
  nick: string;
  countryCode: string;
  /** First day the player plays, counted from the start of the history. */
  startDay: number;
  /** Chance of playing on any given day. */
  playRate: number;
  /** Chance of recognising a typical country at the start, and after lots of practice. */
  recognitionStart: number;
  recognitionPlateau: number;
  /** Games it takes to close 63% of that gap. */
  learningGames: number;
  /** Chance of narrowing down the region once the country is known. */
  regional: number;
  /** Countries the player knows inside out / keeps mixing up. */
  strong: string[];
  weak: string[];
}

export interface DemoOptions {
  seed?: number;
  days?: number;
  /** Last day of the history (YYYY-MM-DD, UTC). Defaults to yesterday. */
  endDate?: string;
  players?: DemoPlayerSpec[];
}

export const DEMO_PLAYERS: DemoPlayerSpec[] = [
  { id: 'demo-alex', nick: 'Alex (demo)', countryCode: 'ES', startDay: 0, playRate: 0.93, recognitionStart: 0.42, recognitionPlateau: 0.86, learningGames: 170, regional: 0.34, strong: ['ES', 'FR', 'IT', 'PT'], weak: ['LV', 'LT', 'EE', 'BG'] },
  { id: 'demo-sam', nick: 'Sam (demo)', countryCode: 'US', startDay: 110, playRate: 0.8, recognitionStart: 0.78, recognitionPlateau: 0.93, learningGames: 120, regional: 0.58, strong: ['US', 'CA', 'MX'], weak: ['KG', 'MN'] },
  { id: 'demo-noor', nick: 'Noor (demo)', countryCode: 'ID', startDay: 240, playRate: 0.72, recognitionStart: 0.28, recognitionPlateau: 0.8, learningGames: 90, regional: 0.3, strong: ['ID', 'MY', 'TH', 'PH'], weak: ['AR', 'CL', 'UY', 'PE'] },
  { id: 'demo-kai', nick: 'Kai (demo)', countryCode: 'DE', startDay: 0, playRate: 0.45, recognitionStart: 0.55, recognitionPlateau: 0.62, learningGames: 200, regional: 0.2, strong: ['DE', 'AT', 'CH'], weak: ['BR', 'CO', 'EC'] },
];

const SCORE_SCALE_KM = 1491.6862;
const RAD = Math.PI / 180;
const DAY_MS = 86400000;

/** Small deterministic PRNG (mulberry32). */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T>(items: T[], weights: number[], total: number, random: () => number): T {
  let r = random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** Point reached from (lat, lng) after `km` along `bearing` (radians) on a sphere. */
function destination(lat: number, lng: number, km: number, bearing: number): [number, number] {
  const d = km / 6371.0088;
  const phi1 = lat * RAD, lam1 = lng * RAD;
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(bearing));
  const lam2 = lam1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2));
  return [Math.max(-85, Math.min(85, phi2 / RAD)), ((lam2 / RAD + 540) % 360) - 180];
}

const scoreFor = (km: number): number => Math.round(5000 * Math.exp(-km / SCORE_SCALE_KM));

export function generateDemo(geo: Geo, options: DemoOptions = {}): ExportFile {
  const random = createRandom(options.seed ?? 20240612);
  const days = options.days ?? 540;
  const specs = options.players ?? DEMO_PLAYERS;
  const end = options.endDate ? Date.parse(`${options.endDate}T00:00:00Z`) : Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS;
  const start = end - (days - 1) * DAY_MS;

  // Countries that come up, roughly the way a balanced world map distributes its locations.
  const countries = [...geo.countries.values()].filter((c) => c.cells >= 8 && c.guess);
  const weights = countries.map((c) => c.cells ** 0.55);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const share = new Map(countries.map((c, i) => [c.cc, weights[i] / totalWeight]));
  const medianShare = [...share.values()].sort((a, b) => a - b)[Math.floor(share.size / 2)];

  const sampleLocation = (): { lat: number; lng: number; cc: string } => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const country = pickWeighted(countries, weights, totalWeight, random);
      const regions = country.regions.map((i) => geo.regions[i]).filter((r) => r.cells > 0 && r.polygons.length > 0);
      if (regions.length === 0) continue;
      const regionWeights = regions.map((r) => r.cells);
      const region: Region = pickWeighted(regions, regionWeights, regionWeights.reduce((s, w) => s + w, 0), random);
      const [minX, minY, maxX, maxY] = region.bbox;
      for (let tries = 0; tries < 300; tries++) {
        const x = minX + random() * (maxX - minX), y = minY + random() * (maxY - minY);
        if (!regionContains(region, x, y)) continue;
        const lat = inverseMercatorY(y), lng = inverseMercatorX(x);
        if (geo.isCovered(lat, lng)) return { lat: +lat.toFixed(5), lng: +lng.toFixed(5), cc: country.cc };
      }
    }
    return { lat: 48.8584, lng: 2.2945, cc: 'FR' };
  };

  const jitter = (point: [number, number], km: number): [number, number] => destination(point[0], point[1], random() * km, random() * 2 * Math.PI);

  const guessFor = (spec: DemoPlayerSpec, gamesPlayed: number, loc: { lat: number; lng: number; cc: string }): ExportGuess => {
    if (random() < 0.008) return { lat: null, lng: null, score: 0, distance: null, time: 180, timedOut: true };
    const country = geo.countries.get(loc.cc)!;
    const learnt = 1 - Math.exp(-gamesPlayed / spec.learningGames);
    const base = spec.recognitionStart + (spec.recognitionPlateau - spec.recognitionStart) * learnt;
    const familiarity = Math.max(-1, Math.min(1, Math.log((share.get(loc.cc) ?? medianShare) / medianShare) / 2));
    const strong = spec.strong.includes(loc.cc), weak = spec.weak.includes(loc.cc);
    const logit = Math.log(base / (1 - base)) + 0.9 * familiarity + (strong ? 1.6 : 0) - (weak ? 1.7 : 0);
    const recognised = random() < 1 / (1 + Math.exp(-logit));
    let guess: [number, number];
    if (recognised) {
      const regional = Math.min(0.95, spec.regional + 0.25 * learnt + (strong ? 0.3 : 0));
      if (random() < regional) {
        const median = 40 + 0.07 * (country.dq?.[2] ?? 300);
        const km = Math.min(median * Math.exp(0.85 * (random() + random() + random() - 1.5) * 1.6), (country.dq?.[4] ?? 2000));
        guess = destination(loc.lat, loc.lng, km, random() * 2 * Math.PI);
      } else {
        guess = jitter(country.guess!, 90);
      }
    } else {
      // Mixed up with another country, more likely a nearby and common one.
      const others = countries.filter((c) => c.cc !== loc.cc);
      const w = others.map((c) => (share.get(c.cc) ?? 0) * Math.exp(-haversineKm(loc.lat, loc.lng, c.guess![0], c.guess![1]) / 2200));
      const other = pickWeighted(others, w, w.reduce((s, v) => s + v, 0), random);
      guess = jitter(other.guess!, 120);
    }
    const km = haversineKm(loc.lat, loc.lng, guess[0], guess[1]);
    return {
      lat: +guess[0].toFixed(5),
      lng: +guess[1].toFixed(5),
      score: scoreFor(km),
      distance: Math.round(km * 1000),
      time: Math.round(12 + random() * (recognised ? 70 : 140)),
    };
  };

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const token = () => Array.from({ length: 16 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
  const played = new Map(specs.map((s) => [s.id, 0]));
  const challenges: ExportChallenge[] = [];

  for (let day = 0; day < days; day++) {
    const dayStart = start + day * DAY_MS;
    const date = new Date(dayStart).toISOString().slice(0, 10);
    const rounds = Array.from({ length: 5 }, sampleLocation);
    const results: ExportResult[] = [];
    for (const spec of specs) {
      if (day < spec.startDay || random() > spec.playRate) continue;
      const games = played.get(spec.id)!;
      const guesses = rounds.map((loc) => guessFor(spec, games, loc));
      played.set(spec.id, games + 1);
      results.push({
        playerId: spec.id,
        total: guesses.reduce((s, g) => s + g.score, 0),
        totalTime: guesses.reduce((s, g) => s + (g.time ?? 0), 0),
        totalDistance: guesses.reduce((s, g) => s + (g.distance ?? 0), 0),
        playedAt: new Date(dayStart + Math.floor((6 + random() * 16) * 3600000)).toISOString(),
        guesses,
      });
    }
    if (results.length === 0) continue;
    challenges.push({
      token: token(), date, map: 'world', mapName: 'World', timeLimit: 180,
      forbidMoving: false, forbidZooming: false, forbidRotating: false,
      rounds: rounds.map((r) => ({ lat: r.lat, lng: r.lng, cc: r.cc, panoId: null })),
      results,
    });
  }

  const players = specs.map((s) => ({ id: s.id, nick: s.nick, countryCode: s.countryCode }));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date(end + DAY_MS).toISOString(),
    source: 'demo',
    owner: players[0],
    players,
    challenges,
  };
}
