import type { RoundRow } from '../data/types';
import type { Geo } from '../geo/geo';

/** 1 degree cells (about 100 km) for the "how much ground have I seen" measure. */
export const EXPLORE_FACTOR = 4;

export interface Exploration {
  countries: Map<string, number>;
  regions: Map<number, number>;
  cells: Set<number>;
  /** What there is to see: places Street View reaches (plus anything the player was actually dropped in). */
  totals: { countries: number; regions: number; cells: number };
  /** Cumulative distinct counts after each day played. */
  timeline: { t: number; countries: number; regions: number; cells: number }[];
  /** Countries with coverage the player has never been dropped in, most common first. */
  unseen: { cc: string; cells: number }[];
}

/** A country counts as "in play" when Street View covers more than a landmark or two. */
const MIN_CELLS_IN_PLAY = 5;

export function explore(rounds: RoundRow[], geo: Geo, pooledCountries?: Set<string>): Exploration {
  const countries = new Map<string, number>();
  const regions = new Map<number, number>();
  const cells = new Set<number>();
  const timeline: Exploration['timeline'] = [];
  const sorted = [...rounds].sort((a, b) => a.t - b.t);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.cc) countries.set(r.cc, (countries.get(r.cc) ?? 0) + 1);
    if (r.region >= 0) regions.set(r.region, (regions.get(r.region) ?? 0) + 1);
    cells.add(geo.coarseCell(r.lat, r.lng, EXPLORE_FACTOR));
    if (i === sorted.length - 1 || sorted[i + 1].t !== r.t) {
      timeline.push({ t: r.t, countries: countries.size, regions: regions.size, cells: cells.size });
    }
  }

  const inPlay = new Set<string>();
  for (const c of geo.countries.values()) if (c.cells >= MIN_CELLS_IN_PLAY) inPlay.add(c.cc);
  if (pooledCountries) for (const cc of pooledCountries) inPlay.add(cc);
  for (const cc of countries.keys()) inPlay.add(cc);

  let regionTotal = 0;
  for (const r of geo.regions) if ((r.cells > 0 && inPlay.has(r.cc)) || regions.has(r.idx)) regionTotal++;
  const covered = geo.coarseCovered(EXPLORE_FACTOR);
  let cellTotal = covered.size;
  for (const c of cells) if (!covered.has(c)) cellTotal++;

  const unseen = [...inPlay]
    .filter((cc) => !countries.has(cc))
    .map((cc) => ({ cc, cells: geo.countries.get(cc)?.cells ?? 0 }))
    .sort((a, b) => b.cells - a.cells);

  return { countries, regions, cells, totals: { countries: inPlay.size, regions: regionTotal, cells: cellTotal }, timeline, unseen };
}
