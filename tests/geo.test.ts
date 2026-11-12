import { describe, expect, it } from 'vitest';
import { haversineKm, inverseMercatorX, inverseMercatorY, mercatorX, mercatorY } from '../src/geo/mercator';
import { loadTestGeo } from './helpers/geo';

const geo = loadTestGeo();
const at = (lat: number, lng: number, hint?: string) => {
  const idx = geo.locate(lat, lng, hint);
  return idx >= 0 ? geo.regions[idx] : null;
};

describe('mercator', () => {
  it('round-trips', () => {
    for (const [lat, lng] of [[0, 0], [48.85, 2.35], [-33.87, 151.21], [78.2, 15.6]]) {
      expect(inverseMercatorY(mercatorY(lat))).toBeCloseTo(lat, 8);
      expect(inverseMercatorX(mercatorX(lng))).toBeCloseTo(lng, 8);
    }
  });

  it('measures great-circle distance', () => {
    expect(haversineKm(48.8566, 2.3522, 51.5074, -0.1278)).toBeGreaterThan(335);
    expect(haversineKm(48.8566, 2.3522, 51.5074, -0.1278)).toBeLessThan(350);
  });
});

describe('region lookup', () => {
  it('places well-known cities', () => {
    const cases: [number, number, string, RegExp][] = [
      [48.8566, 2.3522, 'FR', /Paris/],
      [40.7128, -74.006, 'US', /New York/],
      [-33.8688, 151.2093, 'AU', /New South Wales/],
      [-23.5505, -46.6333, 'BR', /S.o Paulo/],
      [35.6762, 139.6503, 'JP', /Tokyo|Tōkyō/],
      [64.1466, -21.9426, 'IS', /./],
      [21.3069, -157.8583, 'US', /Hawaii/],
      [55.7558, 37.6173, 'RU', /Mosc|Moskva/],
      [-1.2921, 36.8219, 'KE', /Nairobi/],
    ];
    for (const [lat, lng, cc, name] of cases) {
      const region = at(lat, lng);
      expect(region, `${lat},${lng}`).not.toBeNull();
      expect(region!.cc).toBe(cc);
      expect(region!.name).toMatch(name);
    }
  });

  it('uses the country codes GeoGuessr reports for territories', () => {
    expect(at(43.7384, 7.4246)?.cc).toBe('MC');
    expect(at(1.3521, 103.8198)?.cc).toBe('SG');
    expect(at(-21.1151, 55.5364)?.cc).toBe('RE');
    expect(at(78.2232, 15.6267)?.cc).toBe('SJ');
    expect(at(18.2208, -66.5901)?.cc).toBe('PR');
    expect(at(22.3193, 114.1694)?.cc).toBe('HK');
    expect(at(4.9372, -52.326)?.cc).toBe('GF');
  });

  it('returns -1 in the open ocean', () => {
    expect(geo.locate(30, -40)).toBe(-1);
    expect(geo.locateCountry(-45, -120)).toBeNull();
  });

  it('snaps to the hinted country when the outline misses a coastal point', () => {
    // A little offshore from the Portuguese coast.
    const region = at(38.62, -9.38, 'PT');
    expect(region?.cc).toBe('PT');
    // The hint wins over a neighbouring polygon right at a border.
    expect(at(42.4334, 1.9286, 'ES')?.cc).toBe('ES');
  });
});

describe('coverage', () => {
  it('knows where Street View is', () => {
    expect(geo.isCovered(48.8566, 2.3522)).toBe(true);
    expect(geo.isCovered(40.7128, -74.006)).toBe(true);
    expect(geo.isCovered(23, 10)).toBe(false); // central Sahara
    expect(geo.isCovered(75, -40)).toBe(false); // Greenland ice sheet
  });

  it('has sensible country statistics', () => {
    const us = geo.countries.get('US')!;
    expect(us.cells).toBeGreaterThan(8000);
    expect(us.cov).toBeGreaterThan(0.5);
    // The best single guess for the United States sits in the middle of the country.
    expect(us.guess![0]).toBeGreaterThan(34);
    expect(us.guess![0]).toBeLessThan(43);
    expect(us.guess![1]).toBeGreaterThan(-102);
    expect(us.guess![1]).toBeLessThan(-86);
    expect(geo.countries.get('LU')!.base!).toBeGreaterThan(4700);
    expect(geo.countries.get('RU')!.base!).toBeLessThan(3000);
    expect(geo.countries.get('KP')!.cells).toBe(0);
    expect(geo.grid.count).toBeGreaterThan(40000);
  });

  it('summarises regions', () => {
    const california = geo.regions.find((r) => r.cc === 'US' && r.name === 'California')!;
    expect(california.cells).toBeGreaterThan(300);
    expect(california.dq![2]).toBeGreaterThan(1500); // far from the middle of the country
    const coarse = geo.coarseCovered(4);
    expect(coarse.size).toBeGreaterThan(4000);
    expect(coarse.has(geo.coarseCell(48.8566, 2.3522, 4))).toBe(true);
  });
});
