import { beforeAll, describe, expect, it } from 'vitest';
import { buildSeries, emptyDataset, mergeExport, type SeriesBundle } from '../src/data/dataset';
import { generateDemo } from '../src/data/demo';
import { toLocator } from '../src/data/locator';
import type { DayRow, PlayerSeries, RoundRow } from '../src/data/types';
import { countryStats, scoreByRoundNumber } from '../src/stats/countries';
import { explore } from '../src/stats/explore';
import { comparableDays, headToHead, standings, streaks } from '../src/stats/leaderboard';
import { distanceForScore, fitProbabilityModel, geometricScore, shareWithin, type ModelInput } from '../src/stats/probability';
import { loadTestGeo } from './helpers/geo';

const geo = loadTestGeo();
const END = '2025-08-31';
let bundle: SeriesBundle;
let alex: PlayerSeries;

beforeAll(() => {
  const demo = generateDemo(geo, { seed: 11, days: 540, endDate: END });
  bundle = buildSeries(mergeExport(emptyDataset(), demo).dataset, toLocator(geo));
  alex = bundle.byId.get('demo-alex')!;
});

const modelInput = (rounds: RoundRow[], threshold = 4000): ModelInput => ({
  rounds: rounds.map((r) => ({ cc: r.cc, region: r.region, score: r.score })),
  pooledRounds: bundle.pooledRounds.map((r) => ({ cc: r.cc, region: r.region })),
  regions: geo.regions.map((r) => ({ cc: r.cc, cells: r.cells, dq: r.dq })),
  threshold,
  scoreScaleKm: geo.meta.scoreScaleKm,
});

describe('probability model helpers', () => {
  it('converts scores to distances on the world map', () => {
    expect(distanceForScore(4000, 1491.6862)).toBeCloseTo(332.86, 1);
    expect(distanceForScore(2500, 1491.6862)).toBeCloseTo(1033.96, 1);
  });

  it('reads a share off five quantiles', () => {
    const dq = [100, 200, 300, 400, 500];
    expect(shareWithin(dq, 50)).toBe(0);
    expect(shareWithin(dq, 100)).toBe(0);
    expect(shareWithin(dq, 250)).toBeCloseTo(0.375, 9);
    expect(shareWithin(dq, 500)).toBe(1);
    expect(shareWithin([120, 120, 120, 120, 120], 119)).toBe(0);
    expect(shareWithin([120, 120, 120, 120, 120], 121)).toBe(1);
  });

  it('scores a degenerate distribution exactly', () => {
    expect(geometricScore([0, 0, 0, 0, 0], 1491.6862)).toBeCloseTo(5000, 6);
    expect(geometricScore([1491.6862, 1491.6862, 1491.6862, 1491.6862, 1491.6862], 1491.6862)).toBeCloseTo(5000 / Math.E, 6);
  });
});

describe('probability model', () => {
  it('produces estimates for every covered region and nothing where Street View does not go', () => {
    const model = fitProbabilityModel(modelInput(alex.rounds));
    expect(model.overall.n).toBe(alex.rounds.length);
    geo.regions.forEach((r, i) => {
      const e = model.regions[i];
      if (r.cells === 0) { expect(e).toBeNull(); return; }
      expect(e).not.toBeNull();
      expect(e!.p).toBeGreaterThan(0);
      expect(e!.p).toBeLessThan(1);
      expect(e!.lo).toBeLessThanOrEqual(e!.p);
      expect(e!.hi).toBeGreaterThanOrEqual(e!.p);
      expect(e!.expected).toBeGreaterThanOrEqual(0);
      expect(e!.expected).toBeLessThanOrEqual(5000);
    });
    // Shares of rounds add up to about one over all regions.
    const totalShare = model.regions.reduce((s, e) => s + (e ? e.share : 0), 0);
    expect(totalShare).toBeGreaterThan(0.9);
    expect(totalShare).toBeLessThan(1.05);
  });

  it('shrinks: estimates sit between the prior and the raw rate, closer to the data with more rounds', () => {
    const model = fitProbabilityModel(modelInput(alex.rounds));
    let checked = 0;
    for (const e of model.countries.values()) {
      if (e.n < 5) continue;
      const raw = e.good / e.n;
      const lo = Math.min(raw, e.prior) - 1e-9, hi = Math.max(raw, e.prior) + 1e-9;
      expect(e.p).toBeGreaterThanOrEqual(lo);
      expect(e.p).toBeLessThanOrEqual(hi);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
    const big = [...model.countries.values()].filter((e) => e.n >= 60);
    for (const e of big) expect(Math.abs(e.p - e.good / e.n)).toBeLessThan(0.12);
    // Unseen places have wide intervals; well-known ones narrow.
    const unseen = model.regions.filter((e) => e && e.n === 0) as { lo: number; hi: number }[];
    const meanWidth = unseen.reduce((s, e) => s + (e.hi - e.lo), 0) / unseen.length;
    expect(meanWidth).toBeGreaterThan(0.2);
    for (const e of big) expect(e.hi - e.lo).toBeLessThan(0.2);
    // The prior never outweighs more than a couple of dozen real rounds.
    expect(model.strength.country).toBeLessThanOrEqual(16);
    expect(model.strength.region).toBeLessThanOrEqual(12);
  });

  it('finds what the demo player is good and bad at', () => {
    const model = fitProbabilityModel(modelInput(alex.rounds));
    const p = (cc: string) => model.countries.get(cc)!.p;
    // Alex is strong in Spain/France/Italy and keeps confusing the Baltics.
    expect(p('ES')).toBeGreaterThan(p('BG') + 0.15);
    expect(p('FR')).toBeGreaterThan(p('EE') + 0.15);
    // Coverage geometry matters for a player who often falls back to the middle of a country:
    // the learnt weight is positive, and far-flung regions rate below central ones.
    expect(model.weights.geometry).toBeGreaterThan(0);
    const region = (cc: string, name: string) => model.regions[geo.regions.findIndex((r) => r.cc === cc && r.name === name)]!;
    expect(region('US', 'Kansas').p).toBeGreaterThan(region('US', 'Alaska').p);
    expect(region('US', 'Missouri').prior).toBeGreaterThan(region('US', 'Hawaii').prior);
    expect(region('BR', 'Goiás').prior).toBeGreaterThan(region('BR', 'Rio Grande do Sul').prior);
  });

  it('responds to the threshold', () => {
    const easy = fitProbabilityModel(modelInput(alex.rounds, 2500));
    const hard = fitProbabilityModel(modelInput(alex.rounds, 4800));
    expect(easy.overall.rate).toBeGreaterThan(hard.overall.rate);
    expect(easy.countries.get('BR')!.p).toBeGreaterThan(hard.countries.get('BR')!.p);
    expect(easy.thresholdKm).toBeGreaterThan(hard.thresholdKm);
  });

  it('falls back gracefully with very little data', () => {
    const model = fitProbabilityModel(modelInput(alex.rounds.slice(0, 10)));
    expect(model.weights.geometry).toBe(0);
    expect(model.weights.usedRounds).toBe(0);
    const values = model.regions.filter((e) => e && e.n === 0).map((e) => e!.p);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(0.35);
    const none = fitProbabilityModel(modelInput([]));
    expect(none.overall.n).toBe(0);
    expect(none.regions.some((e) => e !== null)).toBe(true);
  });
});

describe('country statistics', () => {
  it('summarises each country and tests for trends', () => {
    const stats = countryStats(alex.rounds, { threshold: 4000, hasGuessCountries: true });
    expect(stats.reduce((s, c) => s + c.n, 0)).toBe(alex.rounds.length);
    expect(stats[0].n).toBeGreaterThanOrEqual(stats[1].n);
    const us = stats.find((c) => c.cc === 'US')!;
    expect(us.n).toBeGreaterThan(50);
    expect(us.hitRate).toBeGreaterThan(0.4);
    expect(us.hitRate).toBeLessThanOrEqual(1);
    expect(us.trend).not.toBeNull();
    expect(us.trend!.lo).toBeLessThan(us.trend!.perYear);
    expect(us.trend!.pAdjusted).toBeGreaterThanOrEqual(us.trend!.pValue - 1e-12);
    // The demo player learns, so most well-sampled countries trend upwards.
    const trends = stats.filter((c) => c.trend && c.n >= 30);
    expect(trends.filter((c) => c.trend!.perYear > 0).length).toBeGreaterThan(trends.length * 0.7);
    // The Baltics get mixed up with each other or their neighbours.
    const lv = stats.find((c) => c.cc === 'LV');
    if (lv && lv.n >= 6) expect(lv.hitRate!).toBeLessThan(0.6);
    expect(countryStats(alex.rounds, { threshold: 4000, hasGuessCountries: false })[0].hitRate).toBeNull();
  });

  it('averages by round position', () => {
    const by = scoreByRoundNumber(alex.rounds);
    expect(by.map((b) => b.round)).toEqual([1, 2, 3, 4, 5]);
    expect(by.every((b) => b.n === alex.days.length)).toBe(true);
  });
});

describe('leaderboard', () => {
  const day = (t: number, total: number, token = `c${t}`): DayRow => ({ token, date: '', t: t * 86400000, total, totalTime: null, playedAt: null, rounds: [] });
  const player = (id: string, slot: number, days: DayRow[]): PlayerSeries => ({ player: { id, nick: id, slot }, days, rounds: [] });

  it('counts streaks of consecutive days', () => {
    const days = [1, 2, 3, 5, 6, 7, 8, 10].map((t) => day(t, 1));
    expect(streaks(days, 10 * 86400000)).toEqual({ current: 1, longest: 4 });
    expect(streaks(days, 11 * 86400000)).toEqual({ current: 1, longest: 4 });
    expect(streaks(days, 12 * 86400000)).toEqual({ current: 0, longest: 4 });
    expect(streaks([], 0)).toEqual({ current: 0, longest: 0 });
  });

  it('ranks players and counts wins on shared days', () => {
    const a = player('a', 0, [day(1, 20000), day(2, 15000), day(3, 22000), day(4, 10000)]);
    const b = player('b', 1, [day(1, 18000), day(2, 15000), day(3, 23000)]);
    const table = standings([a, b], { commonOnly: false }, 4 * 86400000);
    expect(table.map((s) => s.id)).toEqual(['b', 'a']);
    const sa = table.find((s) => s.id === 'a')!, sb = table.find((s) => s.id === 'b')!;
    expect(sa).toMatchObject({ games: 4, contested: 3, wins: 2, best: 22000, currentStreak: 4, rank: 2 });
    expect(sb).toMatchObject({ games: 3, contested: 3, wins: 2, rank: 1 });
    expect(sa.mean).toBeCloseTo(16750, 6);

    const common = standings([a, b], { commonOnly: true }, 4 * 86400000);
    expect(common.find((s) => s.id === 'a')!.games).toBe(3);
    expect(comparableDays([a, b], { commonOnly: true }).get('a')!.map((d) => d.token)).toEqual(['c1', 'c2', 'c3']);

    const h2h = headToHead([a, b], 'a', { commonOnly: false });
    expect(h2h).toEqual([{ opponent: 'b', days: 3, wins: 1, losses: 1, ties: 1, meanMargin: (2000 + 0 - 1000) / 3 }]);
    expect(standings([a, b], { commonOnly: false, from: 3 * 86400000 }, 0).find((s) => s.id === 'a')!.games).toBe(2);
  });

  it('holds together on the demo data', () => {
    const table = standings(bundle.series, { commonOnly: false }, Date.parse(`${END}T00:00:00Z`));
    expect(table).toHaveLength(4);
    expect(table.map((s) => s.rank)).toEqual([1, 2, 3, 4]);
    // The strongest demo player by design.
    expect(table[0].id).toBe('demo-sam');
    for (const s of table) {
      expect(s.wins).toBeLessThanOrEqual(s.contested);
      expect(s.contested).toBeLessThanOrEqual(s.games);
    }
  });
});

describe('exploration', () => {
  it('counts distinct countries, regions and cells over time', () => {
    const result = explore(alex.rounds, geo);
    expect(result.countries.size).toBeGreaterThan(60);
    expect(result.totals.countries).toBeGreaterThanOrEqual(result.countries.size);
    expect(result.regions.size).toBeGreaterThan(500);
    expect(result.totals.regions).toBeGreaterThan(result.regions.size);
    expect(result.cells.size).toBeGreaterThan(800);
    expect(result.totals.cells).toBeGreaterThan(result.cells.size);
    const last = result.timeline[result.timeline.length - 1];
    expect(last).toMatchObject({ countries: result.countries.size, regions: result.regions.size, cells: result.cells.size });
    expect(result.timeline.every((p, i) => i === 0 || (p.countries >= result.timeline[i - 1].countries && p.t > result.timeline[i - 1].t))).toBe(true);
    expect(result.unseen.every((u) => !result.countries.has(u.cc))).toBe(true);
    expect(result.unseen.length).toBe(result.totals.countries - result.countries.size);
  });
});
