/**
 * An in-memory stand-in for the parts of GeoGuessr's web API the collector reads. Response
 * shapes follow what the live site returns (public endpoints were checked directly; the
 * signed-in ones follow the site's own JavaScript and community type definitions).
 */
import type { CollectorResponse } from '../../src/collector/core';
import type { ExportChallenge, ExportFile, ExportResult } from '../../src/data/types';

export interface MockOptions {
  ownerId: string;
  /** Not signed in: every authenticated endpoint answers 401. */
  signedOut?: boolean;
  /** Feed entries before this date carry no isDailyChallenge flag (as old entries do). */
  noDailyFlagBefore?: string;
  /** Challenge tokens that are missing from the activity feed. */
  missingFromFeed?: Set<string>;
  /** Answer 404 for the calendar endpoints, as if they did not exist. */
  noCalendar?: boolean;
  /** Leave the signed-in player out of the friends highscores (forces the /game fallback). */
  ownerNotInHighscores?: boolean;
  /** Number of requests to answer with 429 before behaving. */
  throttleFirst?: number;
  /** "Now", for the today/previous endpoints. */
  today?: string;
  /** Entries per feed page actually returned (the real feed may return fewer than asked). */
  pageSize?: number;
}

const DAY_MS = 86400000;

/** Builds a GeoGuessr-style game object from our own export structures. */
export function toGame(ch: ExportChallenge, result: ExportResult, nick: string, countryCode: string | null, finished = true) {
  const startTime = result.playedAt ?? `${ch.date}T12:00:00.0000000Z`;
  const guesses = finished ? result.guesses : result.guesses.slice(0, 2);
  return {
    token: `game-${ch.token}-${result.playerId}`,
    type: 'challenge',
    mode: 'standard',
    state: finished ? 'finished' : 'started',
    roundCount: ch.rounds.length,
    timeLimit: ch.timeLimit ?? 180,
    forbidMoving: ch.forbidMoving ?? false,
    forbidZooming: ch.forbidZooming ?? false,
    forbidRotating: ch.forbidRotating ?? false,
    streakType: 'countrystreak',
    map: ch.map ?? 'world',
    mapName: ch.mapName ?? 'World',
    panoramaProvider: 1,
    bounds: { min: { lat: -54.85, lng: -159.78 }, max: { lat: 78.66, lng: 178.45 } },
    round: guesses.length,
    rounds: ch.rounds.map((r, i) => ({
      lat: r.lat, lng: r.lng, panoId: '4a6f6e', heading: 0, pitch: 0, zoom: 0,
      streakLocationCode: r.cc ? r.cc.toLowerCase() : null,
      startTime: new Date(Date.parse(startTime) + i * 60000).toISOString(),
    })),
    player: {
      totalScore: { amount: String(result.total), unit: 'points', percentage: result.total / 250 },
      totalDistance: { meters: { amount: '1', unit: 'km' }, miles: { amount: '1', unit: 'miles' } },
      totalDistanceInMeters: result.totalDistance ?? 0,
      totalStepsCount: 0,
      totalTime: result.totalTime ?? 0,
      totalStreak: 0,
      guesses: guesses.map((g) => ({
        lat: g.lat ?? 0, lng: g.lng ?? 0,
        timedOut: g.timedOut === true,
        timedOutWithGuess: false,
        skippedRound: false,
        roundScore: { amount: String(g.score), unit: 'points', percentage: g.score / 50 },
        roundScoreInPercentage: g.score / 50,
        roundScoreInPoints: g.score,
        distance: { meters: { amount: '1', unit: 'km' }, miles: { amount: '1', unit: 'miles' } },
        distanceInMeters: g.distance ?? 0,
        stepsCount: 0,
        streakLocationCode: null,
        time: g.time ?? 0,
      })),
      isLeader: false,
      currentPosition: 0,
      pin: { url: 'pin/x.png', anchor: 'center-center', isDefault: true },
      newBadges: [],
      explorer: null,
      id: result.playerId,
      nick,
      isVerified: false,
      flair: 0,
      countryCode: countryCode ? countryCode.toLowerCase() : 'us',
    },
    progressChange: null,
  };
}

export interface MockApi {
  handle(path: string): CollectorResponse;
  /** Every path requested, in order. */
  calls: string[];
  /** Tokens of the challenges the owner has played. */
  ownerTokens: string[];
}

export function createMockApi(file: ExportFile, options: MockOptions): MockApi {
  const calls: string[] = [];
  const players = new Map(file.players.map((p) => [p.id, p]));
  const byToken = new Map(file.challenges.map((ch) => [ch.token, ch]));
  const ownerPlayed = file.challenges.filter((ch) => ch.results.some((r) => r.playerId === options.ownerId));
  const today = options.today ?? ownerPlayed.map((c) => c.date!).sort().pop()!;
  const pageSize = options.pageSize ?? 50;
  let throttle = options.throttleFirst ?? 0;

  // ---- Activity feed: daily challenges in among everything else a player does --------------
  interface Activity { type: number; time: string; payload: Record<string, unknown> }
  const activities: Activity[] = [];
  ownerPlayed.forEach((ch, i) => {
    const mine = ch.results.find((r) => r.playerId === options.ownerId)!;
    const time = new Date(Date.parse(mine.playedAt ?? `${ch.date}T12:00:00Z`) + 400000).toISOString();
    if (!options.missingFromFeed?.has(ch.token)) {
      const flagged = !options.noDailyFlagBefore || ch.date! >= options.noDailyFlagBefore;
      activities.push({
        type: 2, time,
        payload: { mapSlug: 'world', mapName: 'World', points: mine.total, challengeToken: ch.token, gameMode: 'Standard', ...(flagged ? { isDailyChallenge: true } : {}) },
      });
    }
    // Noise: a duel most days, a classic game now and then, an ordinary challenge sometimes.
    activities.push({ type: 6, time: new Date(Date.parse(time) + 3600000).toISOString(), payload: { gameId: `duel-${i}`, gameMode: 'Duels', competitiveGameMode: 'StandardDuels' } });
    if (i % 3 === 0) activities.push({ type: 1, time: new Date(Date.parse(time) + 7200000).toISOString(), payload: { mapSlug: 'world', mapName: 'World', points: 12345, gameToken: `classic-${i}`, gameMode: 'Standard' } });
    if (i % 7 === 0) {
      activities.push({
        type: 2, time: new Date(Date.parse(time) + 9000000).toISOString(),
        payload: { mapSlug: 'famous-places', mapName: 'Famous Places', points: 20000, challengeToken: `friendly-${i}`, gameMode: 'Standard', ...(i % 14 === 0 ? { isDailyChallenge: false } : {}) },
      });
    }
    if (i % 11 === 0) activities.push({ type: 4, time: new Date(Date.parse(time) + 9500000).toISOString(), payload: { badgeId: 'b', badgeName: 'Badge', badgeLevel: 1, imagePath: 'badge/x.png' } });
  });
  activities.sort((a, b) => b.time.localeCompare(a.time));
  const owner = players.get(options.ownerId)!;
  const feedUser = { id: owner.id, nick: owner.nick, isVerified: false, flair: 0, avatar: { url: 'pin/x.png', isDefault: true, anchor: 'center-center' } };
  // Entries: every third entry bundles the next three activities into a "group" (type 7).
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < activities.length;) {
    if (entries.length % 3 === 2 && i + 3 <= activities.length) {
      const group = activities.slice(i, i + 3);
      entries.push({ type: 7, time: group[0].time, user: feedUser, payload: JSON.stringify(group.map((a) => ({ type: a.type, time: a.time, payload: a.payload }))) });
      i += 3;
    } else {
      const a = activities[i++];
      entries.push({ type: a.type, time: a.time, user: feedUser, payload: JSON.stringify(a.payload) });
    }
  }

  const dailyInfo = (ch: ExportChallenge) => ({
    authorCreator: null,
    date: `${ch.date}T14:44:03.8575991Z`,
    description: null,
    participants: 250000,
    token: ch.token,
    pickedWinner: true,
    leaderboard: [],
    friends: options.signedOut ? null : [],
    country: [],
    club: [],
  });
  const allSorted = [...file.challenges].filter((c) => c.date && c.date <= today).sort((a, b) => a.date!.localeCompare(b.date!));

  const highscoreItem = (ch: ExportChallenge, r: ExportResult) => {
    const p = players.get(r.playerId);
    return {
      gameToken: `game-${ch.token}-${r.playerId}`,
      playerName: p?.nick ?? 'Unknown',
      userId: r.playerId,
      totalScore: r.total,
      isLeader: false,
      pinUrl: 'pin/x.png',
      game: toGame(ch, r, p?.nick ?? 'Unknown', p?.countryCode ?? null),
    };
  };

  const ok = (data: unknown): CollectorResponse => ({ status: 200, data });
  const status = (code: number): CollectorResponse => ({ status: code, data: null });

  function handle(path: string): CollectorResponse {
    calls.push(path);
    if (throttle > 0) { throttle--; return { status: 429, data: null, retryAfterMs: 50 }; }
    const url = new URL(path, 'https://www.geoguessr.com');
    const p = url.pathname;
    const q = url.searchParams;

    if (p === '/api/v3/challenges/daily-challenges/today') {
      const ch = allSorted.filter((c) => c.date === today).pop();
      return ch ? ok(dailyInfo(ch)) : status(404);
    }
    if (p === '/api/v3/challenges/daily-challenges/previous') {
      return ok(allSorted.filter((c) => c.date! < today).slice(-6).reverse().map(dailyInfo));
    }
    const details = p.match(/^\/api\/v3\/challenges\/([^/]+)$/);
    if (details) {
      const token = decodeURIComponent(details[1]);
      const ch = byToken.get(token);
      if (!ch && !token.startsWith('friendly-')) return status(404);
      return ok({
        challenge: {
          token, mapSlug: ch ? 'world' : 'famous-places', roundCount: 5, timeLimit: 180, forbidMoving: false, forbidZooming: false,
          forbidRotating: false, guessMapType: 'roadmap', numberOfParticipants: 1000, gameMode: 'standard',
          challengeType: ch ? 1 : 0, streakType: 'countrystreak', accessLevel: 0, locationOrder: 0,
        },
        map: { id: 'x', name: ch ? 'World' : 'Famous Places', slug: ch ? 'world' : 'famous-places', maxErrorDistance: 14916862 },
        creator: { id: 'creator', nick: 'GeoGuessr' },
      });
    }

    // Everything below needs a session.
    if (options.signedOut) return status(401);

    if (p === '/api/v3/profiles') {
      return ok({ user: { id: owner.id, nick: owner.nick, countryCode: (owner.countryCode ?? 'es').toLowerCase(), isProUser: true }, email: 'hidden@example.com' });
    }
    if (p === '/api/v4/feed/private') {
      const from = q.get('paginationToken') ? Number(Buffer.from(q.get('paginationToken')!, 'base64').toString()) : 0;
      const count = Math.min(Number(q.get('count') ?? 25), pageSize);
      const slice = entries.slice(from, from + count);
      const next = from + count < entries.length ? Buffer.from(String(from + count)).toString('base64') : null;
      return ok({ entries: slice, paginationToken: next });
    }
    const highscores = p.match(/^\/api\/v3\/results\/highscores\/([^/]+)$/);
    if (highscores) {
      const ch = byToken.get(decodeURIComponent(highscores[1]));
      if (!ch) return status(404);
      const mine = ch.results.find((r) => r.playerId === options.ownerId);
      if (!mine) return status(401); // GeoGuessr only shows results of challenges you have played
      if (q.get('friends') !== 'true') return ok({ items: [], paginationToken: null });
      const results = ch.results.filter((r) => !(options.ownerNotInHighscores && r.playerId === options.ownerId));
      return ok({ items: results.sort((a, b) => b.total - a.total).map((r) => highscoreItem(ch, r)), paginationToken: null });
    }
    const game = p.match(/^\/api\/v3\/challenges\/([^/]+)\/game$/);
    if (game) {
      const ch = byToken.get(decodeURIComponent(game[1]));
      const mine = ch?.results.find((r) => r.playerId === options.ownerId);
      if (!ch || !mine) return status(404);
      return ok(toGame(ch, mine, owner.nick, owner.countryCode ?? null));
    }
    if (p === '/api/v3/challenges/daily-challenges/me/month') {
      if (options.noCalendar) return status(404);
      const prefix = `${q.get('year')}-${String(q.get('month')).padStart(2, '0')}`;
      return ok(ownerPlayed.filter((c) => c.date!.startsWith(prefix)).map((c) => ({
        day: Number(c.date!.slice(8, 10)),
        totalScore: c.results.find((r) => r.playerId === options.ownerId)!.total,
        medal: 'Gold',
      })));
    }
    if (p === '/api/v3/challenges/daily-challenges/leaderboard/me') {
      if (options.noCalendar) return status(404);
      const ch = ownerPlayed.find((c) => c.date === q.get('dateStr'));
      if (!ch) return ok({ token: null, entries: [], totalEntries: 0 });
      const mine = ch.results.find((r) => r.playerId === options.ownerId)!;
      return ok({ token: ch.token, entries: [{ userId: owner.id, rank: 1234, isIncognito: false, game: toGame(ch, mine, owner.nick, owner.countryCode ?? null) }], totalEntries: 250000 });
    }
    return status(404);
  }

  return { handle, calls, ownerTokens: ownerPlayed.map((c) => c.token) };
}

/** Collector IO over the mock, with a virtual clock so back-off and spacing cost no real time. */
export function createMockIo(api: MockApi, startTime: number) {
  let clock = startTime;
  return {
    get: async (path: string) => api.handle(path),
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    get clock() { return clock; },
  };
}

export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
