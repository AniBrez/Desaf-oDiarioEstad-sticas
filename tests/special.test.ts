import { describe, expect, it } from 'vitest';
import { betaQuantile, fUpperTail, incompleteBeta, logGamma, normalCdf, studentTCdf, studentTQuantile, studentTTwoSided } from '../src/stats/special';

describe('special functions', () => {
  it('logGamma matches known values', () => {
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
    expect(logGamma(1)).toBeCloseTo(0, 10);
    expect(logGamma(100)).toBeCloseTo(359.1342053695754, 8);
  });

  it('incomplete beta matches closed forms', () => {
    expect(incompleteBeta(0.5, 2, 3)).toBeCloseTo(11 / 16, 10);
    expect(incompleteBeta(0.2, 1, 1)).toBeCloseTo(0.2, 12);
    expect(incompleteBeta(0.3, 4, 1)).toBeCloseTo(0.3 ** 4, 12);
    expect(incompleteBeta(0.9, 0.5, 0.5)).toBeCloseTo((2 / Math.PI) * Math.asin(Math.sqrt(0.9)), 9);
    expect(incompleteBeta(0, 2, 3)).toBe(0);
    expect(incompleteBeta(1, 2, 3)).toBe(1);
  });

  it('beta quantile inverts the CDF', () => {
    expect(betaQuantile(0.5, 2, 2)).toBeCloseTo(0.5, 9);
    for (const [a, b, p] of [[3, 7, 0.1], [0.8, 4.2, 0.9], [40, 12, 0.5]] as const) {
      expect(incompleteBeta(betaQuantile(p, a, b), a, b)).toBeCloseTo(p, 8);
    }
  });

  it('Student t matches table values', () => {
    expect(studentTCdf(2, 10)).toBeCloseTo(0.963306, 5);
    expect(studentTCdf(-2, 10)).toBeCloseTo(1 - 0.963306, 5);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228139, 5);
    expect(studentTQuantile(0.975, 1000)).toBeCloseTo(1.962339, 4);
    expect(studentTTwoSided(2.228139, 10)).toBeCloseTo(0.05, 5);
  });

  it('F upper tail matches a closed form', () => {
    // I_x(a, 1) = x^a, so P(F(2, 20) > 4) = (20 / 28)^10.
    expect(fUpperTail(4, 2, 20)).toBeCloseTo((20 / 28) ** 10, 10);
    expect(fUpperTail(0, 2, 20)).toBe(1);
  });

  it('normal CDF is accurate enough for display', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.2816)).toBeCloseTo(0.1, 4);
  });
});
