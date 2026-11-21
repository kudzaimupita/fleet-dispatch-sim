import { percentile } from '../sim/metrics.ts';
import { Rng } from '../sim/rng.ts';

export interface Interval {
  mean: number;
  lo: number;
  hi: number;
  /** Number of finite values the estimate is based on. */
  n: number;
}

export interface BootstrapOptions {
  resamples?: number;
  seed?: number;
  /** Confidence level, e.g. 0.95. */
  level?: number;
}

/**
 * Mean with a percentile-bootstrap confidence interval: resample the values
 * with replacement, take the mean of each resample, and report the central
 * `level` share of those means. Non-finite values are left out.
 */
export function bootstrapMean(values: readonly number[], options: BootstrapOptions = {}): Interval {
  const resamples = options.resamples ?? 2000;
  const level = options.level ?? 0.95;
  const sample = values.filter((v) => Number.isFinite(v));
  const n = sample.length;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, n };
  const mean = sample.reduce((a, b) => a + b, 0) / n;
  const rng = new Rng(options.seed ?? 1);
  const means = new Array<number>(resamples);
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += sample[rng.int(n)]!;
    means[i] = sum / n;
  }
  const tail = ((1 - level) / 2) * 100;
  return { mean, lo: percentile(means, tail), hi: percentile(means, 100 - tail), n };
}
