import type { Geo } from '../geo/geo';
import type { Locator } from './dataset';

/** Adapts the geodata to what the dataset builder needs to place rounds and guesses. */
export function toLocator(geo: Geo): Locator {
  return {
    locate: geo.locate,
    locateCountry: geo.locateCountry,
    regionCountry: (region) => geo.regions[region]?.cc ?? null,
  };
}
