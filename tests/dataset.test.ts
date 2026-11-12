import { beforeAll, describe, expect, it } from 'vitest';
import { buildSeries, challengeDate, emptyDataset, mergeExport, parseExport, removePlayer, toExport } from '../src/data/dataset';
import { generateDemo } from '../src/data/demo';
import { toLocator } from '../src/data/locator';
import type { ExportChallenge, ExportFile } from '../src/data/types';
import { loadTestGeo } from './helpers/geo';

const geo = loadTestGeo();
let demo: ExportFile;
beforeAll(() => { demo = generateDemo(geo, { seed: 7, days: 120, endDate: '2025-03-31' }); });

describe('parseExport', () => {
  it('accepts a generated export and survives a JSON round trip', () => {
    const parsed = parseExport(JSON.parse(JSON.stringify(demo)));
    expect(parsed.challenges.length).toBe(demo.challenges.length);
    expect(parsed.owner.id).toBe('demo-alex');
    expect(parsed.source).toBe('demo');
  });

  it('rejects things that are not exports with a readable message', () => {
    expect(() => parseExport(null)).toThrow(/not a Desafío Diario export/);
    expect(() => parseExport({ format: 'something-else' })).toThrow(/not a Desafío Diario export/);
    expect(() => parseExport({ format: 'desafio-diario', version: 99, owner: { id: 'a' }, challenges: [] })).toThrow(/newer version/);
    expect(() => parseExport({ format: 'desafio-diario', version: 1, challenges: [] })).toThrow(/whose data/);
  });

  it('drops malformed parts instead of trusting them', () => {
    const parsed = parseExport({
      format: 'desafio-diario', version: 1, owner: { id: 'me', nick: 'Me' },
      challenges: [
        { token: 'ok', date: '2025-01-01', rounds: [{ lat: 1, lng: 2, cc: 'fr' }], results: [
          { playerId: 'me', total: 99999, guesses: [{ lat: 500, lng: 2, score: 99999 }] },
          { playerId: 'bad', guesses: [{ score: 'x' }] },
        ] },
        { token: 'bad-round', rounds: [{ lat: 'x', lng: 2 }], results: [] },
        { rounds: [], results: [] },
        'nonsense',
      ],
    });
    expect(parsed.challenges).toHaveLength(1);
    const ch = parsed.challenges[0];
    expect(ch.rounds[0].cc).toBe('FR');
    expect(ch.results).toHaveLength(1);
    expect(ch.results[0].guesses[0]).toMatchObject({ lat: null, lng: null, score: 5000 });
    expect(parsed.players.map((p) => p.id)).toEqual(['me']);
  });
});

describe('mergeExport', () => {
  it('is idempotent and assigns stable colour slots', () => {
    const once = mergeExport(emptyDataset(), demo);
    expect(once.summary.newChallenges).toBe(demo.challenges.length);
    expect(once.dataset.players['demo-alex'].slot).toBe(0);
    const slots = Object.values(once.dataset.players).map((p) => p.slot).sort();
    expect(slots).toEqual([...slots.keys()]);
    const twice = mergeExport(once.dataset, demo);
    expect(twice.summary).toMatchObject({ newPlayers: 0, newChallenges: 0, newResults: 0 });
    expect(twice.dataset.players).toEqual(once.dataset.players);
  });

  it('adds a friend\'s own export to challenges that are already known', () => {
    const mine: ExportFile = { ...demo, challenges: demo.challenges.map((ch) => ({ ...ch, results: ch.results.filter((r) => r.playerId === 'demo-alex') })).filter((ch) => ch.results.length) };
    const friend: ExportFile = {
      ...demo,
      owner: demo.players.find((p) => p.id === 'demo-kai')!,
      challenges: demo.challenges.map((ch) => ({ ...ch, results: ch.results.filter((r) => r.playerId === 'demo-kai') })).filter((ch) => ch.results.length),
    };
    const a = mergeExport(emptyDataset(), mine);
    const b = mergeExport(a.dataset, friend);
    expect(b.summary.newPlayers).toBe(1);
    expect(b.dataset.players['demo-kai'].slot).toBe(1);
    const both = demo.challenges.filter((ch) => ['demo-alex', 'demo-kai'].every((id) => ch.results.some((r) => r.playerId === id)));
    expect(both.length).toBeGreaterThan(10);
    for (const ch of both) expect(b.dataset.challenges[ch.token].results.map((r) => r.playerId).sort()).toEqual(['demo-alex', 'demo-kai']);
    // Removing the friend restores the original picture.
    const c = removePlayer(b.dataset, 'demo-kai');
    expect(Object.keys(c.challenges).length).toBe(Object.keys(a.dataset.challenges).length);
    expect(c.players['demo-kai']).toBeUndefined();
  });

  it('round-trips through toExport', () => {
    const { dataset } = mergeExport(emptyDataset(), demo);
    const again = mergeExport(emptyDataset(), parseExport(JSON.parse(JSON.stringify(toExport(dataset, 'demo-alex')))));
    expect(Object.keys(again.dataset.challenges).length).toBe(demo.challenges.length);
    expect(again.dataset.players['demo-alex'].demo).toBe(true);
  });
});

describe('challenge dates', () => {
  const base: ExportChallenge = { token: 't', date: null, map: 'world', timeLimit: 180, forbidMoving: false, forbidZooming: false, forbidRotating: false, rounds: [], results: [] };
  const result = (playedAt: string | null) => ({ playerId: 'p', total: 0, totalTime: null, totalDistance: null, playedAt, guesses: [] });

  it('prefers the official date', () => {
    expect(challengeDate({ ...base, date: '2024-05-05', results: [result('2024-05-09T10:00:00Z')] })).toBe('2024-05-05');
  });

  it('otherwise uses the earliest time anyone played (UTC)', () => {
    expect(challengeDate({ ...base, results: [result('2024-05-07T23:59:00Z'), result('2024-05-06T00:30:00Z'), result(null)] })).toBe('2024-05-06');
    expect(challengeDate({ ...base, results: [result(null)] })).toBeNull();
  });
});

describe('buildSeries', () => {
  it('flattens days and rounds and resolves regions', () => {
    const { dataset } = mergeExport(emptyDataset(), demo);
    const bundle = buildSeries(dataset, toLocator(geo));
    const alex = bundle.byId.get('demo-alex')!;
    const expected = demo.challenges.filter((ch) => ch.results.some((r) => r.playerId === 'demo-alex')).length;
    expect(alex.days.length).toBe(expected);
    expect(alex.rounds.length).toBe(expected * 5);
    expect(alex.days.every((d, i) => i === 0 || d.t >= alex.days[i - 1].t)).toBe(true);
    expect(alex.days[0].rounds.reduce((s, r) => s + r.score, 0)).toBe(alex.days[0].total);
    // Every demo location is on land and in the country it claims.
    for (const r of alex.rounds) {
      expect(r.region).toBeGreaterThanOrEqual(0);
      expect(geo.regions[r.region].cc).toBe(r.cc);
    }
    // Guesses get a country when they land on one.
    expect(alex.rounds.filter((r) => r.guessCc !== null).length).toBeGreaterThan(alex.rounds.length * 0.8);
    expect(bundle.pooledRounds.length).toBe(demo.challenges.length * 5);
    expect(bundle.firstDate).toBe(demo.challenges[0].date);
    expect(bundle.lastDate).toBe('2025-03-31');
    expect(bundle.series.map((s) => s.player.slot)).toEqual([...bundle.series.map((s) => s.player.slot)].sort((a, b) => a - b));
  });

  it('works without geodata and skips unfinished games', () => {
    const broken: ExportFile = { ...demo, challenges: demo.challenges.map((ch, i) => (i === 0 ? { ...ch, results: ch.results.map((r) => ({ ...r, guesses: r.guesses.slice(0, 3) })) } : ch)) };
    const { dataset } = mergeExport(emptyDataset(), broken);
    const bundle = buildSeries(dataset, null);
    const total = bundle.series.reduce((s, p) => s + p.days.length, 0);
    const expected = demo.challenges.slice(1).reduce((s, ch) => s + ch.results.length, 0);
    expect(total).toBe(expected);
    expect(bundle.series[0].rounds[0].region).toBe(-1);
  });
});
