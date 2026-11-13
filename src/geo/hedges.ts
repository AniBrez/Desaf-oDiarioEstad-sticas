/** Precomputed duel hedges (public/data/hedges.json, written by scripts/build-geodata.ts). */

export interface HedgePin {
  lat: number;
  lng: number;
}

export interface CountryHedge {
  cc: string;
  /** Street View locations behind the estimate. */
  locations: number;
  solo: { pin: HedgePin; expected: number; miss: [number, number, number] };
  team: { pins: [HedgePin, HedgePin]; expected: number; shareA: number; miss: [number, number, number] };
  /** Covered 0.25 degree grid cells of the country. */
  cells: number[];
}

export interface Hedges {
  scoreScaleKm: number;
  gridCols: number;
  cellDeg: number;
  countries: Map<string, CountryHedge>;
}

interface HedgeFile {
  meta: { scoreScaleKm: number; gridCols: number; cellDeg: number };
  countries: Record<string, {
    n: number;
    one: { p: [number, number]; e: number; m: [number, number, number] };
    two: { p: [[number, number], [number, number]]; e: number; s: number; m: [number, number, number] };
    cells: number[];
  }>;
}

export function parseHedges(file: HedgeFile): Hedges {
  const countries = new Map<string, CountryHedge>();
  for (const [cc, c] of Object.entries(file.countries)) {
    let acc = 0;
    const cells = c.cells.map((d) => (acc += d));
    countries.set(cc, {
      cc,
      locations: c.n,
      solo: { pin: { lat: c.one.p[0], lng: c.one.p[1] }, expected: c.one.e, miss: c.one.m },
      team: {
        pins: [{ lat: c.two.p[0][0], lng: c.two.p[0][1] }, { lat: c.two.p[1][0], lng: c.two.p[1][1] }],
        expected: c.two.e,
        shareA: c.two.s,
        miss: c.two.m,
      },
      cells,
    });
  }
  return { scoreScaleKm: file.meta.scoreScaleKm, gridCols: file.meta.gridCols, cellDeg: file.meta.cellDeg, countries };
}

let pending: Promise<Hedges> | null = null;

export function loadHedges(): Promise<Hedges> {
  if (!pending) {
    pending = fetch(`${import.meta.env.BASE_URL}data/hedges.json`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Could not load the duel hedges (${res.status})`))))
      .then((file: HedgeFile) => parseHedges(file));
    pending.catch(() => { pending = null; });
  }
  return pending;
}

/** "38.46° N, 88.28° W" */
export function formatLatLng(p: HedgePin): string {
  const lat = `${Math.abs(p.lat).toFixed(2)}° ${p.lat >= 0 ? 'N' : 'S'}`;
  const lng = `${Math.abs(p.lng).toFixed(2)}° ${p.lng >= 0 ? 'E' : 'W'}`;
  return `${lat}, ${lng}`;
}

/** "38.4585, -88.2831": pastes straight into Google Maps' search box. */
export const decimalLatLng = (p: HedgePin): string => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;

export const mapsLink = (p: HedgePin): string => `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
