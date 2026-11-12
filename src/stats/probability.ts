/**
 * "How likely am I to do well here?" - a small hierarchical model.
 *
 * A player meets most regions only a handful of times (or never), so raw success rates per
 * region are mostly noise. The model therefore combines three sources, weakest first:
 *
 *   1. Street View coverage geometry. For every region we know how far its coverage lies from
 *      the best single guess for its country. A region close to that point can be scored well
 *      with country knowledge alone; a far-flung one (Alaska, Kaliningrad, Sabah ...) cannot.
 *      How much that matters differs per player, so its weight is learnt from the player's own
 *      rounds with a penalised logistic regression, together with a "familiarity" term (how
 *      often the country comes up).
 *   2. The player's record in the rest of the country, which shifts every region of that
 *      country up or down.
 *   3. The player's record in the region itself.
 *
 * Each level is a Beta-Binomial update. The prior strengths (how many rounds of evidence the
 * prior is worth) are estimated from the data by maximising the marginal likelihood.
 */
import { logisticRidge } from './logistic';
import { ols } from './regression';
import { betaQuantile, clamp, logBeta, logit, sigmoid } from './special';

export interface RegionCoverage {
  /** Upper-case ISO alpha-2 of the country the region belongs to. */
  cc: string;
  /** Number of covered grid cells; 0 means Street View never goes there. */
  cells: number;
  /** Distance (km) from the country's best guess to the region's covered cells: min, q25, median, q75, max. */
  dq: number[] | null;
}

export interface ModelRound {
  cc: string | null;
  region: number;
  score: number;
}

export interface ModelInput {
  /** The player's rounds. */
  rounds: ModelRound[];
  /** Every distinct round of every imported challenge (whoever played it): how often places come up. */
  pooledRounds: { cc: string | null; region: number }[];
  regions: RegionCoverage[];
  /** A round counts as "good" from this score upwards. */
  threshold: number;
  /** Score decay length in km: score = 5000 * exp(-distance / scale). */
  scoreScaleKm: number;
}

export interface Estimate {
  /** Rounds the player has had here. */
  n: number;
  /** Of those, how many were good. */
  good: number;
  /** Estimated probability of a good round. */
  p: number;
  /** 80% credible interval (computed on first use). */
  readonly lo: number;
  readonly hi: number;
  /** What the model expected before looking at this place's own rounds. */
  prior: number;
  /** Estimated expected round score. */
  expected: number;
  /** Plain average of the player's scores here (null without rounds). */
  meanScore: number | null;
  /** Estimated share of all rounds that land here. */
  share: number;
}

export interface ModelOutput {
  threshold: number;
  /** Distance within which a guess scores at least the threshold. */
  thresholdKm: number;
  overall: { n: number; good: number; rate: number; meanScore: number };
  /** One entry per region; null where there is neither coverage nor data. */
  regions: (Estimate | null)[];
  countries: Map<string, Estimate>;
  /** Learnt weights (on the logit scale) - shown in the "how it works" note. */
  weights: { intercept: number; geometry: number; familiarity: number; usedRounds: number };
  /** Prior strengths in pseudo-rounds. */
  strength: { country: number; region: number };
}

/**
 * Candidate prior strengths, in "rounds of evidence". The caps are deliberate: however well the
 * coverage-based prior fits on average, it should never outweigh more than a couple of dozen real
 * rounds in a country, or a dozen in a region - players have blind spots no prior can know about.
 */
const COUNTRY_STRENGTHS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16];
const REGION_STRENGTHS = [1, 1.5, 2, 3, 4, 6, 8, 12];
const MIN_ROUNDS_FOR_REGRESSION = 40;

/** Distance in km at which a guess is worth exactly `score` points. */
export function distanceForScore(score: number, scoreScaleKm: number): number {
  return -Math.log(clamp(score, 1, 4999.5) / 5000) * scoreScaleKm;
}

/** Share of a distance distribution (given by five quantiles) that lies within `km`. */
export function shareWithin(dq: number[], km: number): number {
  const probs = [0, 0.25, 0.5, 0.75, 1];
  if (km < dq[0]) return 0;
  if (km >= dq[4]) return 1;
  for (let i = 0; i < 4; i++) {
    if (km < dq[i + 1]) {
      const span = dq[i + 1] - dq[i];
      return probs[i] + (span > 0 ? ((km - dq[i]) / span) * 0.25 : 0.25);
    }
  }
  return 1;
}

/** Expected score of the country's best single guess for rounds that fall in this region. */
export function geometricScore(dq: number[], scoreScaleKm: number): number {
  const f = (d: number) => 5000 * Math.exp(-d / scoreScaleKm);
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += 0.25 * (f(dq[i]) + 4 * f((dq[i] + dq[i + 1]) / 2) + f(dq[i + 1])) / 6;
  return sum;
}

/** Marginal-likelihood estimate of a Beta prior's strength, given prior means and outcomes. */
function estimateStrength(units: { n: number; good: number; prior: number }[], grid: number[], fallback: number, minUnits: number): number {
  const withData = units.filter((u) => u.n > 0);
  if (withData.length < minUnits) return fallback;
  let best = fallback, bestLl = -Infinity;
  for (const k of grid) {
    let ll = 0;
    for (const u of withData) {
      const a = k * u.prior, b = k * (1 - u.prior);
      ll += logBeta(a + u.good, b + u.n - u.good) - logBeta(a, b);
    }
    if (ll > bestLl) { bestLl = ll; best = k; }
  }
  return best;
}

interface Tally { n: number; good: number; sum: number }
const emptyTally = (): Tally => ({ n: 0, good: 0, sum: 0 });

export function fitProbabilityModel(input: ModelInput): ModelOutput {
  const { regions, threshold, scoreScaleKm } = input;
  const thresholdKm = distanceForScore(threshold, scoreScaleKm);
  const regionCount = regions.length;

  // ---- Tallies ----------------------------------------------------------------------------
  const regionTally: Tally[] = Array.from({ length: regionCount }, emptyTally);
  const countryTally = new Map<string, Tally>();
  const overall = emptyTally();
  const countryOf = (r: ModelRound | { cc: string | null; region: number }): string | null =>
    r.cc ?? (r.region >= 0 ? regions[r.region].cc : null);

  for (const r of input.rounds) {
    const good = r.score >= threshold ? 1 : 0;
    overall.n++; overall.good += good; overall.sum += r.score;
    if (r.region >= 0) {
      const t = regionTally[r.region];
      t.n++; t.good += good; t.sum += r.score;
    }
    const cc = countryOf(r);
    if (cc) {
      let t = countryTally.get(cc);
      if (!t) countryTally.set(cc, t = emptyTally());
      t.n++; t.good += good; t.sum += r.score;
    }
  }
  const overallRate = overall.n ? (overall.good + 1) / (overall.n + 2) : 0.5;
  const overallMean = overall.n ? overall.sum / overall.n : 2500;

  // ---- How often places come up -------------------------------------------------------------
  const cellsByCountry = new Map<string, number>();
  const regionsByCountry = new Map<string, number[]>();
  let totalCells = 0;
  regions.forEach((r, i) => {
    let list = regionsByCountry.get(r.cc);
    if (!list) regionsByCountry.set(r.cc, list = []);
    list.push(i);
    if (r.cells > 0) {
      cellsByCountry.set(r.cc, (cellsByCountry.get(r.cc) ?? 0) + r.cells);
      totalCells += r.cells;
    }
  });
  const pooledCountry = new Map<string, number>();
  const pooledRegion = new Array<number>(regionCount).fill(0);
  let pooledTotal = 0;
  for (const r of input.pooledRounds) {
    const cc = countryOf(r);
    if (!cc) continue;
    pooledTotal++;
    pooledCountry.set(cc, (pooledCountry.get(cc) ?? 0) + 1);
    if (r.region >= 0) pooledRegion[r.region]++;
  }
  // Observed frequency, smoothed towards the coverage footprint (worth 150 rounds of evidence).
  const FOOTPRINT_WEIGHT = 150;
  const countryShare = (cc: string): number => {
    const footprint = totalCells > 0 ? (cellsByCountry.get(cc) ?? 0) / totalCells : 0;
    return ((pooledCountry.get(cc) ?? 0) + FOOTPRINT_WEIGHT * footprint) / (pooledTotal + FOOTPRINT_WEIGHT);
  };
  const regionWeight = (i: number): number => {
    const total = cellsByCountry.get(regions[i].cc) ?? 0;
    return total > 0 ? regions[i].cells / total : 0;
  };
  const REGION_WEIGHT = 20;
  const regionShare = (i: number): number => {
    const cc = regions[i].cc;
    const within = (pooledRegion[i] + REGION_WEIGHT * regionWeight(i)) / ((pooledCountry.get(cc) ?? 0) + REGION_WEIGHT);
    return countryShare(cc) * within;
  };

  // ---- Features ---------------------------------------------------------------------------
  const geometry = (i: number): number => {
    const dq = regions[i].dq;
    return dq ? logit(clamp(shareWithin(dq, thresholdKm), 0.03, 0.97)) : 0;
  };
  const geometryScore = (i: number): number => {
    const dq = regions[i].dq;
    return dq ? geometricScore(dq, scoreScaleKm) / 1000 : overallMean / 1000;
  };
  const rawFamiliarity = (cc: string): number => Math.log(Math.max(countryShare(cc), 1e-5));

  const usable = input.rounds.filter((r) => r.region >= 0);
  let famMean = 0, famSd = 1;
  if (usable.length > 1) {
    const values = usable.map((r) => rawFamiliarity(regions[r.region].cc));
    famMean = values.reduce((s, v) => s + v, 0) / values.length;
    famSd = Math.sqrt(values.reduce((s, v) => s + (v - famMean) ** 2, 0) / values.length) || 1;
  }
  const familiarity = (cc: string): number => clamp((rawFamiliarity(cc) - famMean) / famSd, -3, 3);

  // ---- Prior means from coverage ------------------------------------------------------------
  let weights = { intercept: logit(overallRate), geometry: 0, familiarity: 0, usedRounds: 0 };
  let scoreBeta = [overallMean, 0, 0];
  if (usable.length >= MIN_ROUNDS_FOR_REGRESSION) {
    const X = usable.map((r) => [1, geometry(r.region), familiarity(regions[r.region].cc)]);
    const beta = logisticRidge(X, usable.map((r) => (r.score >= threshold ? 1 : 0)), [0, 4, 4]);
    if (beta) weights = { intercept: beta[0], geometry: beta[1], familiarity: beta[2], usedRounds: usable.length };
    const Xs = usable.map((r) => [1, geometryScore(r.region), familiarity(regions[r.region].cc)]);
    const fit = ols(Xs, usable.map((r) => r.score), [0, 4, 4]);
    if (fit) scoreBeta = fit.beta;
  }
  const priorP = (i: number): number =>
    clamp(sigmoid(weights.intercept + weights.geometry * geometry(i) + weights.familiarity * familiarity(regions[i].cc)), 0.01, 0.99);
  const priorScore = (i: number): number =>
    clamp(scoreBeta[0] + scoreBeta[1] * geometryScore(i) + scoreBeta[2] * familiarity(regions[i].cc), 0, 5000);

  // ---- Country level ------------------------------------------------------------------------
  interface CountryState { cc: string; prior: number; priorScore: number; tally: Tally }
  const countryState = new Map<string, CountryState>();
  const allCountries = new Set<string>([...regionsByCountry.keys(), ...countryTally.keys()]);
  for (const cc of allCountries) {
    const list = (regionsByCountry.get(cc) ?? []).filter((i) => regions[i].cells > 0);
    let prior = overallRate, ps = overallMean;
    if (list.length > 0) {
      prior = 0; ps = 0;
      for (const i of list) { const w = regionWeight(i); prior += w * priorP(i); ps += w * priorScore(i); }
    }
    countryState.set(cc, { cc, prior: clamp(prior, 0.01, 0.99), priorScore: ps, tally: countryTally.get(cc) ?? emptyTally() });
  }
  const countryStrength = estimateStrength(
    [...countryState.values()].map((c) => ({ n: c.tally.n, good: c.tally.good, prior: c.prior })), COUNTRY_STRENGTHS, 6, 8);

  const posterior = (n: number, good: number, sum: number, prior: number, priorMean: number, k: number, share: number): Estimate => {
    const a = good + k * prior, b = n - good + k * (1 - prior);
    // The interval needs two Beta quantiles; with thousands of regions they are only worth
    // computing for the few that are actually looked at.
    let interval: [number, number] | null = null;
    const bounds = () => (interval ??= [betaQuantile(0.1, a, b), betaQuantile(0.9, a, b)]);
    return {
      n, good,
      p: a / (a + b),
      get lo() { return bounds()[0]; },
      get hi() { return bounds()[1]; },
      prior,
      expected: clamp((sum + k * priorMean) / (n + k), 0, 5000),
      meanScore: n > 0 ? sum / n : null,
      share,
    };
  };

  const countries = new Map<string, Estimate>();
  for (const c of countryState.values()) {
    const covered = (cellsByCountry.get(c.cc) ?? 0) > 0;
    if (!covered && c.tally.n === 0) continue;
    countries.set(c.cc, posterior(c.tally.n, c.tally.good, c.tally.sum, c.prior, c.priorScore, countryStrength, countryShare(c.cc)));
  }

  // ---- Region level -------------------------------------------------------------------------
  // What the *rest* of the country says about a region (leaving the region's own rounds out, so
  // they are not counted twice).
  const regionPrior = (i: number): { p: number; score: number } => {
    const c = countryState.get(regions[i].cc);
    const base = regions[i].cells > 0 ? priorP(i) : c ? c.prior : overallRate;
    const baseScore = regions[i].cells > 0 ? priorScore(i) : c ? c.priorScore : overallMean;
    if (!c) return { p: base, score: baseScore };
    const own = regionTally[i];
    const n = c.tally.n - own.n, good = c.tally.good - own.good, sum = c.tally.sum - own.sum;
    if (n <= 0) return { p: base, score: baseScore };
    const restP = (good + countryStrength * c.prior) / (n + countryStrength);
    const restScore = (sum + countryStrength * c.priorScore) / (n + countryStrength);
    return {
      p: clamp(sigmoid(logit(base) + logit(clamp(restP, 0.005, 0.995)) - logit(c.prior)), 0.01, 0.99),
      score: clamp(baseScore + restScore - c.priorScore, 0, 5000),
    };
  };
  const priors = regions.map((_, i) => regionPrior(i));
  const regionStrength = estimateStrength(
    regions.map((_, i) => ({ n: regionTally[i].n, good: regionTally[i].good, prior: priors[i].p })), REGION_STRENGTHS, 4, 20);

  const regionEstimates = regions.map((r, i): Estimate | null => {
    const t = regionTally[i];
    if (r.cells === 0 && t.n === 0) return null;
    return posterior(t.n, t.good, t.sum, priors[i].p, priors[i].score, regionStrength, regionShare(i));
  });

  return {
    threshold,
    thresholdKm,
    overall: { n: overall.n, good: overall.good, rate: overall.n ? overall.good / overall.n : 0, meanScore: overall.n ? overallMean : 0 },
    regions: regionEstimates,
    countries,
    weights,
    strength: { country: countryStrength, region: regionStrength },
  };
}
