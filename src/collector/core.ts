/**
 * Collects a player's Daily Challenge history from GeoGuessr's own web API.
 *
 * This module is environment-agnostic: every request goes through `CollectorIO`, so the same
 * code runs in the browser (on geoguessr.com, with the player's session) and in tests (against
 * a mock). It only ever issues GET requests - nothing here can start a game or change anything
 * on the account.
 *
 * Endpoints used (all part of the site's own JavaScript at the time of writing):
 *   /api/v3/profiles                                   who is signed in
 *   /api/v4/feed/private                               activity feed -> which challenges were daily
 *   /api/v3/challenges/{token}                         challenge details (older feed entries lack the daily flag)
 *   /api/v3/challenges/daily-challenges/me/month       calendar of played days (fills gaps in the feed)
 *   /api/v3/challenges/daily-challenges/leaderboard/me the challenge behind a calendar day
 *   /api/v3/results/highscores/{token}?friends=true    per-round results of the player and their friends
 *   /api/v3/challenges/{token}/game                    the player's own game, if the above lacks it
 *   /api/v3/challenges/daily-challenges/today|previous official dates of the latest challenges
 */
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type ExportChallenge,
  type ExportFile,
  type ExportGuess,
  type ExportPlayer,
  type ExportResult,
  type ExportRound,
} from '../data/types';

export interface CollectorResponse {
  /** HTTP status; 0 for a network failure. */
  status: number;
  data: unknown;
  retryAfterMs?: number;
}

export interface CollectorIO {
  get(path: string): Promise<CollectorResponse>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface CollectorCache {
  version: 1;
  ownerId: string;
  challenges: ExportChallenge[];
  /** Challenge tokens that were checked and are not daily challenges. */
  notDaily: string[];
  /** Time of the newest feed entry seen by a walk that reached the end (or known ground). */
  feedHighWater: string | null;
}

export interface CollectorProgress {
  phase: 'account' | 'feed' | 'calendar' | 'results' | 'done';
  message: string;
  done?: number;
  total?: number;
}

export interface CollectorOptions {
  cache?: CollectorCache | null;
  /** Ignore the cache and fetch everything again. */
  full?: boolean;
  /** Also keep friends' results on the challenges the player played. Default true. */
  includeFriends?: boolean;
  onProgress?: (progress: CollectorProgress) => void;
  /** Set `aborted` to stop at the next request. */
  signal?: { aborted: boolean };
  /** Parallel requests while fetching results. Default 3. */
  concurrency?: number;
  /** Minimum gap between request starts in ms. Default 140. */
  intervalMs?: number;
  /** Challenges younger than this many days are re-fetched (friends may have played since). Default 8. */
  refreshDays?: number;
  /** Safety valve for the feed walk. Default 4000 pages. */
  maxFeedPages?: number;
}

export interface CollectorResult {
  file: ExportFile;
  cache: CollectorCache;
  warnings: string[];
  stats: { requests: number; feedPages: number; fetched: number; reused: number; players: number };
}

export class CollectorError extends Error {
  constructor(public readonly code: 'not-signed-in' | 'aborted' | 'unexpected', message: string) {
    super(message);
    this.name = 'CollectorError';
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers for reading untyped JSON
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const upperCc = (v: unknown): string | null => {
  const s = str(v);
  return s && /^[a-zA-Z]{2}$/.test(s) ? s.toUpperCase() : null;
};
const utcDate = (iso: string | null): string | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------------------------
// Parsing GeoGuessr objects
// ---------------------------------------------------------------------------------------------

/** Activity type 2 is "played a challenge"; type 7 bundles several activities into one feed entry. */
const ACTIVITY_PLAYED_CHALLENGE = 2;
const ACTIVITY_GROUP = 7;
/** Challenge type 1 is "official": the daily challenge. */
const CHALLENGE_TYPE_OFFICIAL = 1;

export interface FeedActivity {
  type: number | null;
  time: string | null;
  payload: Json;
}

function parsePayload(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/** Flattens one feed entry into its activities (group entries hold several). */
export function expandFeedEntry(entry: unknown): FeedActivity[] {
  if (!isObject(entry)) return [];
  const payload = parsePayload(entry.payload);
  const time = str(entry.time);
  if (Array.isArray(payload)) {
    return payload.filter(isObject).map((sub) => {
      const inner = parsePayload(sub.payload);
      return { type: num(sub.type), time: str(sub.time) ?? time, payload: isObject(inner) ? inner : {} };
    });
  }
  return [{ type: num(entry.type), time, payload: isObject(payload) ? payload : {} }];
}

export interface ParsedGame {
  player: ExportPlayer;
  rounds: ExportRound[];
  result: ExportResult;
  finished: boolean;
  map: string | null;
  mapName: string | null;
  timeLimit: number | null;
  forbidMoving: boolean | null;
  forbidZooming: boolean | null;
  forbidRotating: boolean | null;
}

/** Reads a GeoGuessr game object (as returned by the results and game endpoints). */
export function parseGame(game: unknown, fallback?: { userId?: unknown; nick?: unknown }): ParsedGame | null {
  if (!isObject(game) || !isObject(game.player)) return null;
  const player = game.player;
  const id = str(player.id) ?? str(fallback?.userId);
  if (!id) return null;
  const roundCount = num(game.roundCount) ?? 5;
  const rawRounds = asArray(game.rounds).slice(0, roundCount);
  const rounds: ExportRound[] = [];
  for (const r of rawRounds) {
    if (!isObject(r)) return null;
    const lat = num(r.lat), lng = num(r.lng);
    if (lat === null || lng === null) return null;
    rounds.push({ lat, lng, cc: upperCc(r.streakLocationCode), panoId: str(r.panoId) });
  }
  if (rounds.length === 0) return null;

  const guesses: ExportGuess[] = [];
  for (const g of asArray(player.guesses).slice(0, roundCount)) {
    if (!isObject(g)) return null;
    const score = num(g.roundScoreInPoints) ?? (isObject(g.roundScore) ? num(g.roundScore.amount) : null);
    if (score === null) return null;
    const noPin = g.timedOut === true && g.timedOutWithGuess !== true;
    guesses.push({
      lat: noPin ? null : num(g.lat),
      lng: noPin ? null : num(g.lng),
      score,
      distance: num(g.distanceInMeters),
      time: num(g.time),
      ...(g.timedOut === true ? { timedOut: true } : {}),
    });
  }
  const total = (isObject(player.totalScore) ? num(player.totalScore.amount) : null) ?? guesses.reduce((s, g) => s + g.score, 0);
  const firstRound = isObject(rawRounds[0]) ? rawRounds[0] : {};
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
  return {
    player: { id, nick: str(player.nick) ?? str(fallback?.nick) ?? 'Unknown player', countryCode: upperCc(player.countryCode) },
    rounds,
    result: {
      playerId: id,
      total,
      totalTime: num(player.totalTime),
      totalDistance: num(player.totalDistanceInMeters),
      playedAt: str(firstRound.startTime),
      guesses,
    },
    finished: guesses.length >= rounds.length && (game.state === undefined || game.state === 'finished'),
    map: str(game.map),
    mapName: str(game.mapName),
    timeLimit: num(game.timeLimit),
    forbidMoving: bool(game.forbidMoving),
    forbidZooming: bool(game.forbidZooming),
    forbidRotating: bool(game.forbidRotating),
  };
}

// ---------------------------------------------------------------------------------------------
// Polite HTTP client: spacing, bounded concurrency, retries with back-off
// ---------------------------------------------------------------------------------------------

class Client {
  requests = 0;
  private nextSlot = 0;

  constructor(private io: CollectorIO, private intervalMs: number, private signal?: { aborted: boolean }) {}

  async get(path: string): Promise<CollectorResponse> {
    for (let attempt = 0; ; attempt++) {
      if (this.signal?.aborted) throw new CollectorError('aborted', 'Stopped.');
      const now = this.io.now();
      const wait = Math.max(0, this.nextSlot - now);
      this.nextSlot = Math.max(now, this.nextSlot) + this.intervalMs;
      if (wait > 0) await this.io.sleep(wait);
      this.requests++;
      let res: CollectorResponse;
      try {
        res = await this.io.get(path);
      } catch {
        res = { status: 0, data: null };
      }
      const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 5) return res;
      const backoff = res.retryAfterMs ?? Math.min(30000, 1000 * 2 ** attempt);
      // Everyone waits when the server asks us to slow down.
      this.nextSlot = Math.max(this.nextSlot, this.io.now() + backoff);
      await this.io.sleep(backoff);
    }
  }
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run));
}

// ---------------------------------------------------------------------------------------------
// The collection itself
// ---------------------------------------------------------------------------------------------

interface Candidate {
  /** When the feed says it was played. */
  time: string | null;
  /** true / false as flagged by the feed, null when the feed does not say. */
  daily: boolean | null;
  points: number | null;
}

export async function collect(io: CollectorIO, options: CollectorOptions = {}): Promise<CollectorResult> {
  const warnings: string[] = [];
  const progress = options.onProgress ?? (() => {});
  const client = new Client(io, options.intervalMs ?? 140, options.signal);
  const concurrency = options.concurrency ?? 3;
  const includeFriends = options.includeFriends !== false;

  // ---- 1. Who is signed in ------------------------------------------------------------------
  progress({ phase: 'account', message: 'Checking who is signed in…' });
  const profile = await client.get('/api/v3/profiles');
  if (profile.status === 401 || profile.status === 403) {
    throw new CollectorError('not-signed-in', 'You are not signed in to GeoGuessr in this tab. Sign in and run the collector again.');
  }
  let me: ExportPlayer | null = null;
  if (profile.status === 200 && isObject(profile.data)) {
    const user = isObject(profile.data.user) ? profile.data.user : profile.data;
    const id = str(user.id) ?? str(user.userId);
    if (id) me = { id, nick: str(user.nick) ?? 'Me', countryCode: upperCc(user.countryCode) };
  }

  const cache = !options.full && options.cache && options.cache.version === 1 && (!me || options.cache.ownerId === me.id) ? options.cache : null;
  const cached = new Map<string, ExportChallenge>();
  if (cache) for (const ch of cache.challenges) cached.set(ch.token, ch);
  const notDaily = new Set<string>(cache?.notDaily ?? []);

  // ---- 2. Activity feed -> which challenges were daily challenges ---------------------------
  const candidates = new Map<string, Candidate>();
  const stopBefore = cache?.feedHighWater ? Date.parse(cache.feedHighWater) - 3 * DAY_MS : null;
  let feedPages = 0;
  let feedComplete = false;
  let newestFeedTime: string | null = null;
  let pageToken: string | null = null;
  const maxPages = options.maxFeedPages ?? 4000;
  for (;;) {
    progress({ phase: 'feed', message: `Reading your activity feed… page ${feedPages + 1}, ${candidates.size} daily challenges so far` });
    const path: string = '/api/v4/feed/private?count=50' + (pageToken ? `&paginationToken=${encodeURIComponent(pageToken)}` : '');
    const res = await client.get(path);
    if (res.status === 401 || res.status === 403) {
      throw new CollectorError('not-signed-in', 'You are not signed in to GeoGuessr in this tab. Sign in and run the collector again.');
    }
    if (res.status !== 200 || !isObject(res.data)) {
      warnings.push(`The activity feed stopped responding on page ${feedPages + 1} (status ${res.status}); older games may be missing.`);
      break;
    }
    feedPages++;
    const entries = asArray(res.data.entries);
    let oldestOnPage = Infinity;
    for (const entry of entries) {
      if (!me && isObject(entry) && isObject(entry.user)) {
        const id = str(entry.user.id);
        if (id) me = { id, nick: str(entry.user.nick) ?? 'Me', countryCode: null };
      }
      for (const activity of expandFeedEntry(entry)) {
        const when = activity.time ? Date.parse(activity.time) : NaN;
        if (!Number.isNaN(when)) {
          oldestOnPage = Math.min(oldestOnPage, when);
          if (!newestFeedTime || activity.time! > newestFeedTime) newestFeedTime = activity.time;
        }
        const token = str(activity.payload.challengeToken);
        if (!token) continue;
        const flag = activity.payload.isDailyChallenge;
        if (flag === false) continue;
        if (flag !== true && activity.type !== ACTIVITY_PLAYED_CHALLENGE && activity.type !== ACTIVITY_GROUP) continue;
        const mode = str(activity.payload.gameMode);
        if (flag !== true && mode && mode.toLowerCase() !== 'standard') continue;
        const existing = candidates.get(token);
        if (!existing || (flag === true && existing.daily !== true)) {
          candidates.set(token, { time: activity.time, daily: flag === true ? true : null, points: num(activity.payload.points) });
        }
      }
    }
    pageToken = str(res.data.paginationToken);
    if (!pageToken || entries.length === 0) { feedComplete = true; break; }
    if (stopBefore !== null && oldestOnPage < stopBefore) { feedComplete = true; break; }
    if (feedPages >= maxPages) {
      warnings.push(`Stopped reading the activity feed after ${maxPages} pages; older games may be missing.`);
      break;
    }
  }
  if (!me) throw new CollectorError('unexpected', 'Could not work out which GeoGuessr account is signed in.');
  const owner = me;

  // ---- 3. Entries without a daily flag: ask the challenge itself -----------------------------
  const undecided = [...candidates.entries()].filter(([token, c]) => c.daily === null && !cached.has(token) && !notDaily.has(token));
  let checked = 0;
  await pool(undecided, concurrency, async ([token, candidate]) => {
    const res = await client.get(`/api/v3/challenges/${encodeURIComponent(token)}`);
    progress({ phase: 'feed', message: 'Checking older challenges…', done: ++checked, total: undecided.length });
    if (res.status === 200 && isObject(res.data) && isObject(res.data.challenge)) {
      if (num(res.data.challenge.challengeType) === CHALLENGE_TYPE_OFFICIAL) candidate.daily = true;
      else notDaily.add(token);
    }
  });
  for (const [token, c] of [...candidates.entries()]) if (c.daily !== true && !cached.has(token)) candidates.delete(token);

  // ---- 4. Official dates of the most recent challenges --------------------------------------
  const officialDate = new Map<string, string>();
  for (const path of ['/api/v3/challenges/daily-challenges/today', '/api/v3/challenges/daily-challenges/previous']) {
    const res = await client.get(path);
    if (res.status !== 200) continue;
    for (const item of Array.isArray(res.data) ? res.data : [res.data]) {
      if (!isObject(item)) continue;
      const token = str(item.token), date = utcDate(str(item.date));
      if (token && date) officialDate.set(token, date);
    }
  }

  // ---- 5. Calendar: catches played days the feed did not list (best effort) -----------------
  try {
    await supplementFromCalendar();
  } catch (err) {
    if (err instanceof CollectorError) throw err;
    warnings.push('The daily challenge calendar could not be read; relying on the activity feed alone.');
  }

  async function supplementFromCalendar(): Promise<void> {
    const playedDates = new Map<string, string>(); // date -> token
    const noteDate = (token: string, date: string | null) => { if (date && !playedDates.has(date)) playedDates.set(date, token); };
    for (const ch of cached.values()) noteDate(ch.token, ch.date ?? utcDate(ch.results.find((r) => r.playerId === owner.id)?.playedAt ?? null));
    for (const [token, c] of candidates) noteDate(token, officialDate.get(token) ?? utcDate(c.time));

    const today = new Date(io.now());
    const earliestKnown = [...playedDates.keys()].sort()[0] ?? null;
    const newestCached = cache ? [...cached.values()].map((c) => c.date ?? '').sort().pop() || null : null;
    const scanFrom = newestCached ?? null; // incremental runs only look at months since the last sync
    let year = today.getUTCFullYear(), month = today.getUTCMonth() + 1;
    let emptyStreak = 0;
    const missing: { date: string; total: number | null }[] = [];
    for (let scanned = 0; scanned < 240; scanned++) {
      const monthKey = `${year}-${String(month).padStart(2, '0')}`;
      if (scanFrom && monthKey < scanFrom.slice(0, 7)) break;
      progress({ phase: 'calendar', message: `Checking the daily challenge calendar… ${monthKey}` });
      const res = await client.get(`/api/v3/challenges/daily-challenges/me/month?year=${year}&month=${month}`);
      if (res.status !== 200) {
        if (scanned === 0) warnings.push(`The daily challenge calendar is not available (status ${res.status}); relying on the activity feed alone.`);
        break;
      }
      const days = Array.isArray(res.data) ? res.data : isObject(res.data) ? asArray(res.data.days ?? res.data.entries) : [];
      let playedThisMonth = 0;
      for (const d of days) {
        if (!isObject(d)) continue;
        const day = num(d.day);
        const total = num(d.totalScore);
        if (day === null || day < 1 || day > 31 || total === null) continue;
        playedThisMonth++;
        const date = `${monthKey}-${String(day).padStart(2, '0')}`;
        if (playedDates.has(date)) { officialDate.set(playedDates.get(date)!, date); continue; }
        missing.push({ date, total });
      }
      emptyStreak = playedThisMonth === 0 ? emptyStreak + 1 : 0;
      if (emptyStreak >= 4 && (!earliestKnown || monthKey < earliestKnown.slice(0, 7))) break;
      month--;
      if (month === 0) { month = 12; year--; }
    }

    // A game played just after midnight UTC can sit one day off in the feed: match on the score.
    const stillMissing = missing.filter(({ date, total }) => {
      const t = Date.parse(date);
      for (const delta of [-DAY_MS, DAY_MS]) {
        const neighbour = new Date(t + delta).toISOString().slice(0, 10);
        const token = playedDates.get(neighbour);
        if (!token || officialDate.has(token)) continue;
        const points = candidates.get(token)?.points ?? cached.get(token)?.results.find((r) => r.playerId === owner.id)?.total ?? null;
        if (points !== null && points === total) { officialDate.set(token, date); return false; }
      }
      return true;
    });

    let resolved = 0;
    await pool(stillMissing, concurrency, async ({ date }) => {
      const res = await client.get(`/api/v3/challenges/daily-challenges/leaderboard/me?dateStr=${date}`);
      progress({ phase: 'calendar', message: 'Looking up days missing from the feed…', done: ++resolved, total: stillMissing.length });
      if (res.status !== 200 || !isObject(res.data)) return;
      const token = str(res.data.token);
      if (!token) return;
      officialDate.set(token, date);
      if (!candidates.has(token) && !cached.has(token)) candidates.set(token, { time: null, daily: true, points: null });
    });
  }

  // ---- 6. Results -----------------------------------------------------------------------------
  const refreshAfter = io.now() - (options.refreshDays ?? 8) * DAY_MS;
  const isRecent = (token: string): boolean => {
    const ch = cached.get(token);
    const date = officialDate.get(token) ?? ch?.date ?? utcDate(candidates.get(token)?.time ?? null) ?? utcDate(ch?.results[0]?.playedAt ?? null);
    return date !== null && Date.parse(date) >= refreshAfter;
  };
  const toFetch = [...new Set([...candidates.keys(), ...[...cached.keys()].filter(isRecent)])]
    .filter((token) => !cached.has(token) || isRecent(token));
  const players = new Map<string, ExportPlayer>([[owner.id, owner]]);
  const fetched = new Map<string, ExportChallenge>();
  let done = 0;
  await pool(toFetch, concurrency, async (token) => {
    const challenge = await fetchChallenge(token);
    progress({ phase: 'results', message: 'Fetching round-by-round results…', done: ++done, total: toFetch.length });
    if (challenge) fetched.set(token, challenge);
  });

  async function fetchChallenge(token: string): Promise<ExportChallenge | null> {
    const games: ParsedGame[] = [];
    const add = (game: unknown, fallback?: { userId?: unknown; nick?: unknown }) => {
      const parsed = parseGame(game, fallback);
      if (parsed && parsed.finished && !games.some((g) => g.player.id === parsed.player.id)) games.push(parsed);
    };
    if (includeFriends) {
      let page: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const path: string = `/api/v3/results/highscores/${encodeURIComponent(token)}?friends=true&limit=50&minRounds=5`
          + (page ? `&paginationToken=${encodeURIComponent(page)}` : '');
        const res = await client.get(path);
        if (res.status !== 200 || !isObject(res.data)) break;
        for (const item of asArray(res.data.items)) {
          if (isObject(item)) add(item.game, { userId: item.userId, nick: item.playerName });
        }
        page = str(res.data.paginationToken);
        if (!page) break;
      }
    }
    if (!games.some((g) => g.player.id === owner.id)) {
      const res = await client.get(`/api/v3/challenges/${encodeURIComponent(token)}/game`);
      if (res.status === 200) add(res.data);
    }
    const mine = games.find((g) => g.player.id === owner.id);
    if (!mine) return null; // not played (or not finished yet): pick it up on a later sync
    for (const g of games) {
      const known = players.get(g.player.id);
      players.set(g.player.id, { ...g.player, countryCode: g.player.countryCode ?? known?.countryCode ?? null });
    }
    return {
      token,
      date: officialDate.get(token) ?? null,
      map: mine.map,
      mapName: mine.mapName,
      timeLimit: mine.timeLimit,
      forbidMoving: mine.forbidMoving,
      forbidZooming: mine.forbidZooming,
      forbidRotating: mine.forbidRotating,
      rounds: mine.rounds,
      results: games.map((g) => g.result),
    };
  }

  // ---- 7. Assemble ----------------------------------------------------------------------------
  const challenges: ExportChallenge[] = [];
  let reused = 0;
  for (const token of new Set([...cached.keys(), ...fetched.keys()])) {
    const fresh = fetched.get(token);
    const old = cached.get(token);
    const ch = fresh ?? old!;
    if (!fresh) reused++;
    challenges.push({ ...ch, date: officialDate.get(token) ?? ch.date ?? old?.date ?? null });
  }
  const knownNicks = new Map<string, ExportPlayer>();
  if (cache) {
    // Player details for cached challenges were stored alongside them on the previous run.
    for (const p of (cache as CollectorCache & { players?: ExportPlayer[] }).players ?? []) knownNicks.set(p.id, p);
  }
  for (const ch of challenges) {
    for (const r of ch.results) {
      if (!players.has(r.playerId)) players.set(r.playerId, knownNicks.get(r.playerId) ?? { id: r.playerId, nick: 'Unknown player' });
    }
  }
  challenges.sort((a, b) => (a.date ?? a.results[0]?.playedAt ?? '').localeCompare(b.date ?? b.results[0]?.playedAt ?? ''));

  const missed = toFetch.length - fetched.size;
  if (missed > 0) warnings.push(`${missed} challenge${missed === 1 ? '' : 's'} could not be read (unfinished games or errors) and will be retried next time.`);

  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date(io.now()).toISOString(),
    source: 'geoguessr',
    owner,
    players: [...players.values()],
    challenges,
  };
  const nextCache: CollectorCache & { players: ExportPlayer[] } = {
    version: 1,
    ownerId: owner.id,
    challenges,
    notDaily: [...notDaily],
    feedHighWater: feedComplete ? newestFeedTime ?? cache?.feedHighWater ?? null : cache?.feedHighWater ?? null,
    players: [...players.values()],
  };
  progress({ phase: 'done', message: `Done: ${challenges.length} daily challenges, ${players.size} player${players.size === 1 ? '' : 's'}.` });
  return {
    file,
    cache: nextCache,
    warnings,
    stats: { requests: client.requests, feedPages, fetched: fetched.size, reused, players: players.size },
  };
}
