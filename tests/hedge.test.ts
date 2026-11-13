import { describe, expect, it } from 'vitest';
import { createRandom } from '../src/data/demo';
import { haversineKm } from '../src/geo/mercator';
import { bestSoloHedge, bestTeamHedge, compass, expectedScore, roundScore, type WeightedPoint } from '../src/stats/hedge';

/** A blob of points around a centre, roughly Gaussian with the given spread in km. */
function blob(lat: number, lng: number, km: number, n: number, seed: number, w = 1): WeightedPoint[] {
  const random = createRandom(seed);
  const out: WeightedPoint[] = [];
  for (let i = 0; i < n; i++) {
    const r = km * Math.sqrt(-2 * Math.log(1 - random()));
    const t = 2 * Math.PI * random();
    out.push({ lat: lat + (r * Math.cos(t)) / 111.195, lng: lng + (r * Math.sin(t)) / (111.195 * Math.cos((lat * Math.PI) / 180)), w });
  }
  return out;
}

describe('round score', () => {
  it('follows the World map formula', () => {
    expect(roundScore(0)).toBe(5000);
    expect(roundScore(1491.6862)).toBeCloseTo(5000 / Math.E, 6);
    expect(roundScore(333)).toBeGreaterThan(3995);
  });
});

describe('solo hedge', () => {
  it('sits in the middle of a symmetric spread', () => {
    const ring: WeightedPoint[] = Array.from({ length: 36 }, (_, i) => {
      const t = (i * Math.PI) / 18;
      return { lat: 10 + 4 * Math.cos(t), lng: 20 + (4 * Math.sin(t)) / Math.cos((10 * Math.PI) / 180), w: 1 };
    });
    const result = bestSoloHedge(ring);
    // The "ring" is drawn in degrees, so on the sphere it is slightly lopsided: allow a few km.
    expect(haversineKm(result.pins[0].lat, result.pins[0].lng, 10, 20)).toBeLessThan(15);
    // Every point is about 445 km away.
    expect(result.expected).toBeCloseTo(roundScore(444.8), -1);
    expect(result.shares[0]).toBeCloseTo(1, 12);
  });

  it('leans towards where most locations are, ignoring distant outliers', () => {
    const points = [...blob(40, -95, 300, 400, 1, 1), ...blob(64, -150, 200, 40, 2, 1)];
    const result = bestSoloHedge(points);
    // Closer to the main cluster than the plain average would be.
    expect(haversineKm(result.pins[0].lat, result.pins[0].lng, 40, -95)).toBeLessThan(500);
  });

  it('is never beaten by any of the locations themselves', () => {
    const points = blob(-25, 135, 900, 300, 3);
    const result = bestSoloHedge(points);
    for (const p of points.slice(0, 60)) expect(expectedScore(points, [p])).toBeLessThanOrEqual(result.expected + 0.5);
  });

  it('works across the antimeridian', () => {
    const points = [...blob(-17.5, 179.3, 60, 80, 4), ...blob(-17.5, -179.6, 60, 80, 5)];
    const result = bestSoloHedge(points);
    expect(Math.abs(result.pins[0].lng)).toBeGreaterThan(178);
    expect(result.miss[1]).toBeLessThan(250);
  });

  it('handles a single location and no locations', () => {
    const one = bestSoloHedge([{ lat: 43.73, lng: 7.42, w: 5 }]);
    expect(one.expected).toBeGreaterThan(4999);
    expect(one.miss[2]).toBeLessThan(0.5);
    expect(bestSoloHedge([]).pins).toEqual([]);
  });
});

describe('team hedge', () => {
  it('puts one teammate on each of two far-apart clusters', () => {
    const west = blob(45, 5, 150, 200, 6), east = blob(45, 35, 150, 200, 7);
    const points = [...west, ...east];
    const team = bestTeamHedge(points);
    const solo = bestSoloHedge(points);
    const [a, b] = team.pins;
    const near = (p: { lat: number; lng: number }, lng: number) => haversineKm(p.lat, p.lng, 45, lng) < 120;
    expect((near(a, 5) && near(b, 35)) || (near(a, 35) && near(b, 5))).toBe(true);
    expect(team.shares[0]).toBeGreaterThan(0.4);
    expect(team.shares[1]).toBeGreaterThan(0.4);
    expect(team.expected).toBeGreaterThan(solo.expected + 800);
    expect(team.miss[0]).toBeLessThan(solo.miss[0]);
  });

  it('never does worse than the solo pin and lists the bigger share first', () => {
    for (const seed of [11, 12, 13]) {
      const points = [...blob(50, 10, 400, 150, seed, 3), ...blob(38, -4, 250, 80, seed + 50, 1), ...blob(60, 25, 300, 60, seed + 90, 2)];
      const solo = bestSoloHedge(points);
      const team = bestTeamHedge(points);
      expect(team.expected).toBeGreaterThanOrEqual(solo.expected - 0.01);
      expect(team.shares[0]).toBeGreaterThanOrEqual(team.shares[1]);
      expect(team.shares[0] + team.shares[1]).toBeCloseTo(1, 9);
      expect(expectedScore(points, team.pins)).toBeCloseTo(team.expected, 0);
    }
  });

  it('is deterministic', () => {
    const points = blob(35, 105, 1200, 300, 21);
    expect(bestTeamHedge(points)).toEqual(bestTeamHedge(points));
  });
});

describe('compass', () => {
  it('names directions', () => {
    expect(compass({ lat: 0, lng: 0 }, { lat: 10, lng: 0 })).toBe('north');
    expect(compass({ lat: 0, lng: 0 }, { lat: -5, lng: -5 })).toBe('south-west');
    expect(compass({ lat: 0, lng: 179 }, { lat: 0, lng: -179 })).toBe('east');
  });
});
