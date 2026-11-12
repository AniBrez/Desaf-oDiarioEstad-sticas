/**
 * Web Mercator, normalised so the whole world is the unit square: x grows east from 0 to 1,
 * y grows south from 0 to 1. The same projection the GeoGuessr guess map uses, which keeps
 * regions looking the way players know them at any zoom.
 */
const MAX_LAT = 85.051129;
const RAD = Math.PI / 180;

export function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

export function mercatorY(lat: number): number {
  const phi = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * RAD;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI);
}

export function inverseMercatorX(x: number): number {
  return x * 360 - 180;
}

export function inverseMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - Math.PI / 2) / RAD;
}

export const EARTH_RADIUS_KM = 6371.0088;
export const EARTH_CIRCUMFERENCE_KM = 2 * Math.PI * EARTH_RADIUS_KM;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * RAD, dLng = (lng2 - lng1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The part of the world the maps show: everything Street View reaches, without the polar caps. */
export const WORLD_VIEW = {
  north: 81.5,
  south: -57.5,
  get top() { return mercatorY(this.north); },
  get bottom() { return mercatorY(this.south); },
};
