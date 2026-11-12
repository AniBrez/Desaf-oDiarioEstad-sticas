import { invertMatrix } from './regression';
import { clamp, logit, sigmoid } from './special';

/**
 * Logistic regression with a ridge penalty, fitted by Newton's method. `lambda[j]` is the
 * penalty on coefficient j (use 0 for the intercept). With little data the penalty pulls the
 * slopes to zero and the model falls back to the overall rate.
 */
export function logisticRidge(X: number[][], y: number[], lambda: number[], iterations = 30): number[] | null {
  const n = y.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0) return null;
  const rate = clamp(y.reduce((s, v) => s + v, 0) / n, 0.01, 0.99);
  let beta = new Array<number>(p).fill(0);
  beta[0] = logit(rate);
  for (let it = 0; it < iterations; it++) {
    const hessian = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    const gradient = new Array<number>(p).fill(0);
    for (let i = 0; i < n; i++) {
      const row = X[i];
      let eta = 0;
      for (let j = 0; j < p; j++) eta += row[j] * beta[j];
      const mu = sigmoid(clamp(eta, -30, 30));
      const w = Math.max(mu * (1 - mu), 1e-9);
      for (let a = 0; a < p; a++) {
        gradient[a] += row[a] * (y[i] - mu);
        for (let b = a; b < p; b++) hessian[a][b] += w * row[a] * row[b];
      }
    }
    for (let a = 0; a < p; a++) {
      gradient[a] -= lambda[a] * beta[a];
      hessian[a][a] += lambda[a];
      for (let b = 0; b < a; b++) hessian[a][b] = hessian[b][a];
    }
    const inv = invertMatrix(hessian);
    if (!inv) return null;
    let maxStep = 0;
    const next = beta.map((b, a) => {
      const step = inv[a].reduce((s, v, j) => s + v * gradient[j], 0);
      maxStep = Math.max(maxStep, Math.abs(step));
      return b + step;
    });
    beta = next;
    if (maxStep < 1e-8) break;
  }
  return beta.every(Number.isFinite) ? beta : null;
}
