import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type Dataset,
  type DayRow,
  type ExportChallenge,
  type ExportFile,
  type ExportGuess,
  type ExportPlayer,
  type ExportResult,
  type ExportRound,
  type Player,
  type PlayerSeries,
  type RoundRow,
} from './types';

export const emptyDataset = (): Dataset => ({ players: {}, challenges: {} });

// ---------------------------------------------------------------------------------------------
// Validation: export files come from disk or from another window, so nothing is taken on trust.
// ---------------------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length < 300 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanPlayer(v: unknown): ExportPlayer | null {
  if (!isObject(v)) return null;
  const id = str(v.id), nick = str(v.nick);
  if (!id) return null;
  const cc = str(v.countryCode);
  return { id, nick: nick ?? 'Unknown player', countryCode: cc ? cc.toUpperCase().slice(0, 2) : null };
}

function cleanRound(v: unknown): ExportRound | null {
  if (!isObject(v)) return null;
  const lat = num(v.lat), lng = num(v.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const cc = str(v.cc);
  return { lat, lng, cc: cc && /^[a-zA-Z]{2}$/.test(cc) ? cc.toUpperCase() : null, panoId: str(v.panoId) };
}

function cleanGuess(v: unknown): ExportGuess | null {
  if (!isObject(v)) return null;
  const score = num(v.score);
  if (score === null) return null;
  const lat = num(v.lat), lng = num(v.lng);
  const valid = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return {
    lat: valid ? lat : null,
    lng: valid ? lng : null,
    score: Math.max(0, Math.min(5000, Math.round(score))),
    distance: num(v.distance),
    time: num(v.time),
    timedOut: v.timedOut === true,
  };
}

function cleanResult(v: unknown): ExportResult | null {
  if (!isObject(v) || !Array.isArray(v.guesses)) return null;
  const playerId = str(v.playerId);
  if (!playerId) return null;
  const guesses = v.guesses.map(cleanGuess);
  if (guesses.length === 0 || guesses.some((g) => g === null)) return null;
  const clean = guesses as ExportGuess[];
  const playedAt = str(v.playedAt);
  return {
    playerId,
    total: num(v.total) ?? clean.reduce((s, g) => s + g.score, 0),
    totalTime: num(v.totalTime),
    totalDistance: num(v.totalDistance),
    playedAt: playedAt && !Number.isNaN(Date.parse(playedAt)) ? playedAt : null,
    guesses: clean,
  };
}

function cleanChallenge(v: unknown): ExportChallenge | null {
  if (!isObject(v) || !Array.isArray(v.rounds) || !Array.isArray(v.results)) return null;
  const token = str(v.token);
  if (!token) return null;
  const rounds = v.rounds.map(cleanRound);
  if (rounds.length === 0 || rounds.some((r) => r === null)) return null;
  const date = str(v.date);
  return {
    token,
    date: date && DATE_RE.test(date) ? date : null,
    map: str(v.map),
    mapName: str(v.mapName),
    timeLimit: num(v.timeLimit),
    forbidMoving: bool(v.forbidMoving),
    forbidZooming: bool(v.forbidZooming),
    forbidRotating: bool(v.forbidRotating),
    rounds: rounds as ExportRound[],
    results: v.results.map(cleanResult).filter((r): r is ExportResult => r !== null),
  };
}

/** Parses untrusted JSON into an export file, or throws an Error whose message can be shown to the user. */
export function parseExport(json: unknown): ExportFile {
  if (!isObject(json)) throw new Error('This is not a Desafío Diario export (expected a JSON object).');
  if (json.format !== EXPORT_FORMAT) throw new Error('This file is not a Desafío Diario export.');
  const version = num(json.version);
  if (version === null || version > EXPORT_VERSION) {
    throw new Error('This export was made by a newer version of the collector. Update the app and try again.');
  }
  const owner = cleanPlayer(json.owner);
  if (!owner) throw new Error('The export does not say whose data it is.');
  if (!Array.isArray(json.challenges)) throw new Error('The export contains no challenges.');
  const players = (Array.isArray(json.players) ? json.players : []).map(cleanPlayer).filter((p): p is ExportPlayer => p !== null);
  if (!players.some((p) => p.id === owner.id)) players.unshift(owner);
  return {
    format: EXPORT_FORMAT,
    version,
    exportedAt: str(json.exportedAt) ?? new Date().toISOString(),
    source: json.source === 'demo' ? 'demo' : 'geoguessr',
    owner,
    players,
    challenges: json.challenges.map(cleanChallenge).filter((c): c is ExportChallenge => c !== null),
  };
}

// ---------------------------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------------------------

export interface MergeSummary {
  owner: ExportPlayer;
  newPlayers: number;
  newChallenges: number;
  newResults: number;
  totalChallenges: number;
}

function nextSlot(players: Record<string, Player>): number {
  const used = new Set(Object.values(players).map((p) => p.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}

/** Folds an export into the dataset. Existing results are kept; anything new is added. */
export function mergeExport(dataset: Dataset, file: ExportFile): { dataset: Dataset; summary: MergeSummary } {
  const players = { ...dataset.players };
  const challenges = { ...dataset.challenges };
  const summary: MergeSummary = { owner: file.owner, newPlayers: 0, newChallenges: 0, newResults: 0, totalChallenges: 0 };
  const demo = file.source === 'demo';

  const referenced = new Set<string>();
  for (const ch of file.challenges) for (const r of ch.results) referenced.add(r.playerId);
  // The owner first, so the person whose export it is gets the first free colour.
  const incoming = [file.owner, ...file.players.filter((p) => p.id !== file.owner.id)];
  for (const p of incoming) {
    if (!referenced.has(p.id) && p.id !== file.owner.id) continue;
    const existing = players[p.id];
    if (existing) {
      players[p.id] = { ...existing, nick: p.nick || existing.nick, countryCode: p.countryCode ?? existing.countryCode };
    } else {
      players[p.id] = { ...p, slot: nextSlot(players), ...(demo ? { demo: true } : {}) };
      summary.newPlayers++;
    }
  }
  for (const id of referenced) {
    if (!players[id]) {
      players[id] = { id, nick: 'Unknown player', slot: nextSlot(players), ...(demo ? { demo: true } : {}) };
      summary.newPlayers++;
    }
  }

  for (const ch of file.challenges) {
    const existing = challenges[ch.token];
    if (!existing) {
      challenges[ch.token] = ch;
      summary.newChallenges++;
      summary.newResults += ch.results.length;
      continue;
    }
    const results = [...existing.results];
    for (const r of ch.results) {
      const at = results.findIndex((x) => x.playerId === r.playerId);
      if (at < 0) { results.push(r); summary.newResults++; }
      else if (r.guesses.length > results[at].guesses.length) results[at] = r;
    }
    challenges[ch.token] = {
      ...existing,
      date: existing.date ?? ch.date,
      map: existing.map ?? ch.map,
      mapName: existing.mapName ?? ch.mapName,
      timeLimit: existing.timeLimit ?? ch.timeLimit,
      forbidMoving: existing.forbidMoving ?? ch.forbidMoving,
      forbidZooming: existing.forbidZooming ?? ch.forbidZooming,
      forbidRotating: existing.forbidRotating ?? ch.forbidRotating,
      rounds: existing.rounds.map((round, i) => ({ ...round, cc: round.cc ?? ch.rounds[i]?.cc ?? null })),
      results,
    };
  }
  summary.totalChallenges = Object.keys(challenges).length;
  return { dataset: { players, challenges }, summary };
}

export function removePlayer(dataset: Dataset, playerId: string): Dataset {
  const players = { ...dataset.players };
  delete players[playerId];
  const challenges: Dataset['challenges'] = {};
  for (const [token, ch] of Object.entries(dataset.challenges)) {
    const results = ch.results.filter((r) => r.playerId !== playerId);
    if (results.length > 0) challenges[token] = { ...ch, results };
  }
  return { players, challenges };
}

/** Writes the dataset back out as an export file (to hand to a friend or keep as a backup). */
export function toExport(dataset: Dataset, ownerId: string): ExportFile {
  const owner = dataset.players[ownerId] ?? Object.values(dataset.players)[0];
  const strip = (p: Player): ExportPlayer => ({ id: p.id, nick: p.nick, countryCode: p.countryCode ?? null });
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    source: Object.values(dataset.players).every((p) => p.demo) ? 'demo' : 'geoguessr',
    owner: owner ? strip(owner) : { id: 'unknown', nick: 'Unknown player' },
    players: Object.values(dataset.players).map(strip),
    challenges: Object.values(dataset.challenges),
  };
}

// ---------------------------------------------------------------------------------------------
// Derived series
// ---------------------------------------------------------------------------------------------

/**
 * The day a challenge belongs to. GeoGuessr's daily challenge runs on UTC days; when the official
 * date is unknown the earliest time anyone we know started playing it is the best evidence.
 */
export function challengeDate(ch: ExportChallenge): string | null {
  if (ch.date) return ch.date;
  let earliest: string | null = null;
  for (const r of ch.results) if (r.playedAt && (!earliest || r.playedAt < earliest)) earliest = r.playedAt;
  if (!earliest) return null;
  const d = new Date(earliest);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export const dateToTime = (date: string): number => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));

export interface Locator {
  locate(lat: number, lng: number, ccHint?: string | null): number;
  locateCountry(lat: number, lng: number): string | null;
  regionCountry(region: number): string | null;
}

export interface SeriesBundle {
  /** Per player, in a stable order (palette slot). */
  series: PlayerSeries[];
  byId: Map<string, PlayerSeries>;
  /** Every distinct round location of every challenge, whoever played it. */
  pooledRounds: { token: string; date: string; round: number; lat: number; lng: number; cc: string | null; region: number }[];
  firstDate: string | null;
  lastDate: string | null;
}

/** Flattens the dataset into per-player day and round rows, resolving regions when geodata is available. */
export function buildSeries(dataset: Dataset, locator?: Locator | null): SeriesBundle {
  const byId = new Map<string, PlayerSeries>();
  for (const p of Object.values(dataset.players)) byId.set(p.id, { player: p, days: [], rounds: [] });
  const pooledRounds: SeriesBundle['pooledRounds'] = [];
  let firstDate: string | null = null, lastDate: string | null = null;

  for (const ch of Object.values(dataset.challenges)) {
    const date = challengeDate(ch);
    if (!date) continue;
    const t = dateToTime(date);
    const located = ch.rounds.map((round) => {
      const region = locator ? locator.locate(round.lat, round.lng, round.cc) : -1;
      const cc = round.cc ?? (region >= 0 && locator ? locator.regionCountry(region) : null);
      return { region, cc };
    });
    let played = false;
    for (const result of ch.results) {
      const s = byId.get(result.playerId);
      if (!s || result.guesses.length < ch.rounds.length) continue; // unfinished game
      played = true;
      const rounds: RoundRow[] = ch.rounds.map((round, i) => {
        const g = result.guesses[i];
        return {
          token: ch.token, date, t, round: i,
          lat: round.lat, lng: round.lng,
          cc: located[i].cc, region: located[i].region,
          score: g.score, distance: g.distance, time: g.time,
          guessLat: g.lat, guessLng: g.lng,
          guessCc: locator && g.lat !== null && g.lng !== null ? locator.locateCountry(g.lat, g.lng) : null,
          timedOut: g.timedOut === true,
        };
      });
      const day: DayRow = { token: ch.token, date, t, total: result.total, totalTime: result.totalTime, playedAt: result.playedAt, rounds };
      s.days.push(day);
    }
    if (!played) continue;
    ch.rounds.forEach((round, i) => pooledRounds.push({ token: ch.token, date, round: i, lat: round.lat, lng: round.lng, cc: located[i].cc, region: located[i].region }));
    if (!firstDate || date < firstDate) firstDate = date;
    if (!lastDate || date > lastDate) lastDate = date;
  }

  for (const s of byId.values()) {
    s.days.sort((a, b) => a.t - b.t || (a.playedAt ?? '').localeCompare(b.playedAt ?? '') || a.token.localeCompare(b.token));
    s.rounds = s.days.flatMap((d) => d.rounds);
  }
  const series = [...byId.values()].filter((s) => s.days.length > 0).sort((a, b) => a.player.slot - b.player.slot);
  return { series, byId, pooledRounds, firstDate, lastDate };
}
