import { beforeAll, describe, expect, it } from 'vitest';
import { collect, CollectorError, expandFeedEntry, parseGame, type CollectorCache } from '../src/collector/core';
import { parseExport } from '../src/data/dataset';
import { generateDemo } from '../src/data/demo';
import type { ExportChallenge, ExportFile } from '../src/data/types';
import { loadTestGeo } from './helpers/geo';
import { addDays, createMockApi, createMockIo, toGame } from './helpers/mockGeoguessr';

const OWNER = 'demo-alex';
const END = '2025-06-30';
let demo: ExportFile;
let ownerDays: ExportChallenge[];

beforeAll(() => {
  demo = generateDemo(loadTestGeo(), { seed: 42, days: 150, endDate: END });
  ownerDays = demo.challenges.filter((ch) => ch.results.some((r) => r.playerId === OWNER));
});

const startTime = Date.parse(`${addDays(END, 1)}T09:00:00Z`);
const byToken = (file: ExportFile) => new Map(file.challenges.map((ch) => [ch.token, ch]));

function expectMatchesSource(file: ExportFile) {
  const got = byToken(file);
  expect(got.size).toBe(ownerDays.length);
  for (const source of ownerDays) {
    const ch = got.get(source.token);
    expect(ch, source.token).toBeDefined();
    expect(ch!.date).toBe(source.date);
    expect(ch!.rounds.map((r) => [r.lat, r.lng, r.cc])).toEqual(source.rounds.map((r) => [r.lat, r.lng, r.cc]));
    expect(ch!.results.map((r) => r.playerId).sort()).toEqual(source.results.map((r) => r.playerId).sort());
    for (const result of source.results) {
      const mine = ch!.results.find((r) => r.playerId === result.playerId)!;
      expect(mine.total).toBe(result.total);
      expect(mine.guesses.map((g) => g.score)).toEqual(result.guesses.map((g) => g.score));
      expect(mine.guesses.map((g) => g.lat)).toEqual(result.guesses.map((g) => g.lat));
      expect(mine.playedAt).toBe(result.playedAt);
    }
  }
}

describe('collector', () => {
  it('collects every daily challenge with per-round results for the player and friends', async () => {
    const api = createMockApi(demo, { ownerId: OWNER });
    const result = await collect(createMockIo(api, startTime));
    expect(result.warnings).toEqual([]);
    expect(result.file.owner.id).toBe(OWNER);
    expectMatchesSource(result.file);
    const expectedPlayers = [...new Set(ownerDays.flatMap((ch) => ch.results.map((r) => r.playerId)))].sort();
    expect(expectedPlayers.length).toBeGreaterThanOrEqual(3);
    expect(result.file.players.map((p) => p.id).sort()).toEqual(expectedPlayers);
    expect(result.file.players.find((p) => p.id === 'demo-sam')!.nick).toBe('Sam (demo)');
    // Ordinary challenges, duels and classic games in the feed are ignored.
    expect(result.file.challenges.some((ch) => ch.token.startsWith('friendly-'))).toBe(false);
    // The output is a valid export file.
    expect(parseExport(JSON.parse(JSON.stringify(result.file))).challenges.length).toBe(ownerDays.length);
    // Only read-only GET endpoints we expect.
    for (const path of api.calls) expect(path).toMatch(/^\/api\/v[34]\/(profiles|feed\/private|challenges|results\/highscores)/);
  });

  it('recognises old feed entries that carry no daily flag', async () => {
    const api = createMockApi(demo, { ownerId: OWNER, noDailyFlagBefore: addDays(END, -60) });
    const result = await collect(createMockIo(api, startTime));
    expectMatchesSource(result.file);
    // The unflagged ordinary challenges were checked once and remembered as not daily.
    expect(result.cache.notDaily.length).toBeGreaterThan(0);
    expect(result.cache.notDaily.every((t) => t.startsWith('friendly-'))).toBe(true);
  });

  it('recovers days the feed does not list from the calendar', async () => {
    const missing = new Set(ownerDays.filter((_, i) => i % 9 === 4).map((ch) => ch.token));
    expect(missing.size).toBeGreaterThan(5);
    const api = createMockApi(demo, { ownerId: OWNER, missingFromFeed: missing });
    const result = await collect(createMockIo(api, startTime));
    expectMatchesSource(result.file);
  });

  it('still works when the calendar endpoints are unavailable', async () => {
    const api = createMockApi(demo, { ownerId: OWNER, noCalendar: true });
    const result = await collect(createMockIo(api, startTime));
    expect(result.warnings.some((w) => /calendar/i.test(w))).toBe(true);
    const got = byToken(result.file);
    expect(got.size).toBe(ownerDays.length);
    // Without official dates, only the latest week is dated; the app derives the rest from play times.
    const undated = result.file.challenges.filter((ch) => ch.date === null);
    expect(undated.length).toBeGreaterThan(ownerDays.length - 10);
    for (const ch of undated) expect(ch.results.find((r) => r.playerId === OWNER)!.playedAt).toBeTruthy();
  });

  it('falls back to the game endpoint when the player is missing from the highscores', async () => {
    const api = createMockApi(demo, { ownerId: OWNER, ownerNotInHighscores: true });
    const result = await collect(createMockIo(api, startTime));
    expectMatchesSource(result.file);
    expect(api.calls.some((p) => /\/api\/v3\/challenges\/[^/]+\/game$/.test(p))).toBe(true);
  });

  it('can leave friends out', async () => {
    const api = createMockApi(demo, { ownerId: OWNER });
    const result = await collect(createMockIo(api, startTime), { includeFriends: false });
    expect(result.file.challenges.length).toBe(ownerDays.length);
    expect(result.file.challenges.every((ch) => ch.results.length === 1 && ch.results[0].playerId === OWNER)).toBe(true);
    expect(api.calls.some((p) => p.includes('/results/highscores/'))).toBe(false);
  });

  it('only fetches what is new on the next run', async () => {
    // First sync: history up to 20 days before the end.
    const cutoff = addDays(END, -20);
    const early: ExportFile = { ...demo, challenges: demo.challenges.filter((ch) => ch.date! <= cutoff) };
    const firstApi = createMockApi(early, { ownerId: OWNER, today: cutoff });
    const first = await collect(createMockIo(firstApi, Date.parse(`${cutoff}T20:00:00Z`)));
    expect(first.cache.feedHighWater).toBeTruthy();

    const cache = JSON.parse(JSON.stringify(first.cache)) as CollectorCache;
    const api = createMockApi(demo, { ownerId: OWNER });
    const second = await collect(createMockIo(api, startTime), { cache });
    expectMatchesSource(second.file);
    expect(second.stats.reused).toBeGreaterThan(80);
    // Far fewer requests than a full run: only the new days, a recent-days refresh and a few feed pages.
    expect(api.calls.length).toBeLessThan(firstApi.calls.length / 2);
    // Friends' nicknames for the reused days survive.
    expect(second.file.players.every((p) => p.nick !== 'Unknown player')).toBe(true);
  });

  it('ignores a cache that belongs to another account', async () => {
    const api = createMockApi(demo, { ownerId: OWNER });
    const foreign: CollectorCache = { version: 1, ownerId: 'someone-else', challenges: [demo.challenges[0]], notDaily: [], feedHighWater: '2030-01-01T00:00:00Z' };
    const result = await collect(createMockIo(api, startTime), { cache: foreign });
    expectMatchesSource(result.file);
  });

  it('waits and retries when throttled', async () => {
    const api = createMockApi(demo, { ownerId: OWNER, throttleFirst: 4 });
    const io = createMockIo(api, startTime);
    const result = await collect(io);
    expectMatchesSource(result.file);
    expect(api.calls.slice(0, 5).every((p) => p === '/api/v3/profiles')).toBe(true);
  });

  it('paces its requests', async () => {
    const api = createMockApi(demo, { ownerId: OWNER });
    const io = createMockIo(api, startTime);
    const result = await collect(io, { intervalMs: 200 });
    // The virtual clock only advances by sleeping, so elapsed time is at least the spacing.
    expect(io.clock - startTime).toBeGreaterThanOrEqual((result.stats.requests - 1) * 200 * 0.95);
  });

  it('says so when nobody is signed in', async () => {
    const api = createMockApi(demo, { ownerId: OWNER, signedOut: true });
    await expect(collect(createMockIo(api, startTime))).rejects.toMatchObject({ code: 'not-signed-in' });
  });

  it('stops when asked', async () => {
    const api = createMockApi(demo, { ownerId: OWNER });
    const signal = { aborted: false };
    const promise = collect(createMockIo(api, startTime), { signal, onProgress: (p) => { if (p.phase === 'results' && (p.done ?? 0) >= 5) signal.aborted = true; } });
    await expect(promise).rejects.toBeInstanceOf(CollectorError);
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(api.calls.length).toBeLessThan(ownerDays.length);
  });

  it('copes with a feed that returns small pages', async () => {
    const api = createMockApi(demo, { ownerId: OWNER, pageSize: 7 });
    const result = await collect(createMockIo(api, startTime));
    expectMatchesSource(result.file);
    expect(result.stats.feedPages).toBeGreaterThan(20);
  });
});

describe('parsing GeoGuessr objects', () => {
  it('expands grouped feed entries', () => {
    const group = { type: 7, time: '2025-01-02T10:00:00Z', payload: JSON.stringify([
      { type: 2, time: '2025-01-02T09:00:00Z', payload: { challengeToken: 'abc', isDailyChallenge: true, points: 20000 } },
      { type: 6, time: '2025-01-02T09:30:00Z', payload: { gameId: 'x' } },
    ]) };
    const activities = expandFeedEntry(group);
    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({ type: 2, time: '2025-01-02T09:00:00Z', payload: { challengeToken: 'abc' } });
    expect(expandFeedEntry({ type: 2, time: 't', payload: '{"challengeToken":"z"}' })[0].payload.challengeToken).toBe('z');
    expect(expandFeedEntry({ type: 2, time: 't', payload: 'not json' })[0].payload).toEqual({});
    expect(expandFeedEntry(null)).toEqual([]);
  });

  it('reads a game, including timeouts and unfinished games', () => {
    const ch = demo.challenges[0];
    const result = { ...ch.results[0], guesses: ch.results[0].guesses.map((g, i) => (i === 2 ? { lat: null, lng: null, score: 0, distance: null, time: 180, timedOut: true } : g)) };
    const parsed = parseGame(toGame(ch, result, 'Nick', 'de'))!;
    expect(parsed.player).toEqual({ id: result.playerId, nick: 'Nick', countryCode: 'DE' });
    expect(parsed.finished).toBe(true);
    expect(parsed.rounds).toHaveLength(5);
    expect(parsed.rounds[0].cc).toBe(ch.rounds[0].cc);
    expect(parsed.result.guesses[2]).toMatchObject({ lat: null, lng: null, score: 0, timedOut: true });
    expect(parsed.result.guesses[0].score).toBe(result.guesses[0].score);
    expect(parsed.timeLimit).toBe(180);
    expect(parseGame(toGame(ch, result, 'Nick', 'de', false))!.finished).toBe(false);
    expect(parseGame({})).toBeNull();
    expect(parseGame({ player: { id: 'x', guesses: [] }, rounds: [] })).toBeNull();
  });
});
