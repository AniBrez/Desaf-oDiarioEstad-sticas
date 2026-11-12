/**
 * The export file is the contract between the collector (which runs on geoguessr.com) and the
 * app. It is plain JSON so friends can pass files around; the app merges any number of them.
 */
export const EXPORT_FORMAT = 'desafio-diario';
export const EXPORT_VERSION = 1;

export interface ExportPlayer {
  id: string;
  nick: string;
  countryCode?: string | null;
}

/** The location a round dropped everyone at. Identical for every player of a challenge. */
export interface ExportRound {
  lat: number;
  lng: number;
  /** ISO 3166-1 alpha-2 as GeoGuessr reports it (upper case), when known. */
  cc: string | null;
  panoId?: string | null;
}

export interface ExportGuess {
  lat: number | null;
  lng: number | null;
  /** 0 to 5000. */
  score: number;
  /** Metres between guess and location. */
  distance: number | null;
  /** Seconds spent on the round. */
  time: number | null;
  timedOut?: boolean;
}

export interface ExportResult {
  playerId: string;
  /** 0 to 25000. */
  total: number;
  totalTime: number | null;
  totalDistance: number | null;
  /** ISO timestamp of when the player started the first round. */
  playedAt: string | null;
  guesses: ExportGuess[];
}

export interface ExportChallenge {
  token: string;
  /** Official challenge day (YYYY-MM-DD, UTC) when GeoGuessr told us; otherwise derived from play times. */
  date: string | null;
  map: string | null;
  mapName?: string | null;
  timeLimit: number | null;
  forbidMoving: boolean | null;
  forbidZooming: boolean | null;
  forbidRotating: boolean | null;
  rounds: ExportRound[];
  results: ExportResult[];
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  source: 'geoguessr' | 'demo';
  /** The account the data was collected with. */
  owner: ExportPlayer;
  players: ExportPlayer[];
  challenges: ExportChallenge[];
}

// ---------------------------------------------------------------------------------------------
// In-app model
// ---------------------------------------------------------------------------------------------

export interface Player extends ExportPlayer {
  /** Fixed palette slot: a player's colour never changes when others are added or hidden. */
  slot: number;
  demo?: boolean;
}

export interface Dataset {
  players: Record<string, Player>;
  challenges: Record<string, ExportChallenge>;
}

/** One guessed round of one player, flattened for analysis. */
export interface RoundRow {
  token: string;
  /** Challenge day, YYYY-MM-DD. */
  date: string;
  /** UTC midnight of `date` in ms. */
  t: number;
  /** 0-based round number. */
  round: number;
  lat: number;
  lng: number;
  /** Country of the location (upper case ISO alpha-2), if known. */
  cc: string | null;
  /** Index into the geodata regions, or -1 when unknown / geodata not loaded. */
  region: number;
  score: number;
  distance: number | null;
  time: number | null;
  guessLat: number | null;
  guessLng: number | null;
  /** Country the guess landed in, when it could be determined. */
  guessCc: string | null;
  timedOut: boolean;
}

/** One played daily challenge of one player. */
export interface DayRow {
  token: string;
  date: string;
  t: number;
  total: number;
  totalTime: number | null;
  playedAt: string | null;
  rounds: RoundRow[];
}

export interface PlayerSeries {
  player: Player;
  days: DayRow[];
  rounds: RoundRow[];
}

export const MAX_ROUND_SCORE = 5000;
export const MAX_TOTAL_SCORE = 25000;
