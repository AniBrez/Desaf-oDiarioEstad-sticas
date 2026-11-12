import { useMemo } from 'react';
import { useApp } from '../data/store';
import { fitProbabilityModel, type ModelOutput } from '../stats/probability';

/** The per-region odds model for the focused player and current filters (null until geodata is in). */
export function useProbabilityModel(): ModelOutput | null {
  const { geo, focus, pooledRounds, settings } = useApp();
  const regions = useMemo(() => geo?.regions.map((r) => ({ cc: r.cc, cells: r.cells, dq: r.dq })) ?? null, [geo]);
  return useMemo(() => {
    if (!geo || !regions || !focus) return null;
    return fitProbabilityModel({
      rounds: focus.rounds.map((r) => ({ cc: r.cc, region: r.region, score: r.score })),
      pooledRounds: pooledRounds.map((r) => ({ cc: r.cc, region: r.region })),
      regions,
      threshold: settings.threshold,
      scoreScaleKm: geo.meta.scoreScaleKm,
    });
  }, [geo, regions, focus, pooledRounds, settings.threshold]);
}
