import { describe, expect, it } from 'vitest';
import { createPolicy } from '../src/policies/index.ts';
import { Simulation } from '../src/sim/engine.ts';
import { computeMetrics, percentile } from '../src/sim/metrics.ts';
import { buildScenario, customScenario } from '../src/sim/scenario.ts';
import { bootstrapMean } from '../src/stats/bootstrap.ts';

describe('percentile', () => {
  it('interpolates between order statistics', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([4, 1, 3, 2], 0)).toBe(1);
    expect(percentile([4, 1, 3, 2], 100)).toBe(4);
    expect(percentile([10, 20], 95)).toBeCloseTo(19.5, 12);
    expect(percentile([7], 95)).toBe(7);
  });

  it('is NaN for an empty sample and leaves the input alone', () => {
    expect(percentile([], 50)).toBeNaN();
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('computeMetrics', () => {
  it('matches a run worked out by hand', () => {
    const scenario = customScenario({
      width: 10,
      height: 1,
      chargers: [[0, 0]],
      robots: [{ at: [0, 0] }],
      jobs: [
        // 2 empty, 4 loaded; waits 8 s; delivered at 8 + 10 + 16 + 10 = 44, deadline 50.
        { pickup: [2, 0], dropoff: [6, 0], release: 0, deadline: 50 },
        // Released at 0 too: 3 empty back, 1 loaded. Picked at 44 + 12 = 56, delivered at 80.
        { pickup: [3, 0], dropoff: [2, 0], release: 0, deadline: 60 },
        // Never reachable in time.
        { pickup: [9, 0], dropoff: [8, 0], release: 0, deadline: 60 },
      ],
      config: { speed: 0.25, loadTime: 10, unloadTime: 10, patience: 70 },
    });
    const sim = new Simulation(scenario, createPolicy('fifo')).run();
    const m = computeMetrics(sim);
    expect(m).toMatchObject({ jobs: 3, delivered: 2, dropped: 1, open: 0, distance: 10 });
    expect(m.waitP50).toBe((8 + 56) / 2);
    expect(m.waitP95).toBeCloseTo(8 + 0.95 * 48, 9);
    expect(m.onTimeRate).toBeCloseTo(1 / 3, 12);
    expect(m.deadheadShare).toBe(5 / 10);
    expect(m.elapsed).toBe(80);
    expect(m.utilisation).toBe(1);
  });

  it('is usable part way through a run', () => {
    const sim = new Simulation(buildScenario({ seed: 1 }), createPolicy('chain'));
    expect(computeMetrics(sim).utilisation).toBeNaN();
    sim.runUntil(1800);
    const m = computeMetrics(sim);
    expect(m.elapsed).toBe(1800);
    expect(m.open).toBeGreaterThanOrEqual(0);
    expect(m.delivered + m.dropped + m.open).toBeLessThan(m.jobs);
    expect(m.utilisation).toBeGreaterThan(0);
    expect(m.utilisation).toBeLessThanOrEqual(1);
    expect(m.deadheadShare).toBeGreaterThan(0);
    expect(m.deadheadShare).toBeLessThan(1);
  });
});

describe('bootstrapMean', () => {
  it('brackets the sample mean', () => {
    const values = [12, 15, 9, 20, 14, 11, 18, 13, 16, 10];
    const { mean, lo, hi, n } = bootstrapMean(values);
    expect(n).toBe(10);
    expect(mean).toBeCloseTo(13.8, 12);
    expect(lo).toBeLessThan(mean);
    expect(hi).toBeGreaterThan(mean);
    // The normal-theory interval is about 13.8 +/- 2.1; the bootstrap should be close.
    expect(lo).toBeGreaterThan(11);
    expect(hi).toBeLessThan(16.6);
  });

  it('is deterministic and collapses for constant data', () => {
    const values = [3, 8, 1, 9, 4];
    expect(bootstrapMean(values, { seed: 5 })).toEqual(bootstrapMean(values, { seed: 5 }));
    expect(bootstrapMean([4, 4, 4, 4])).toEqual({ mean: 4, lo: 4, hi: 4, n: 4 });
  });

  it('narrows with a lower confidence level', () => {
    const values = [3, 8, 1, 9, 4, 7, 2, 6];
    const wide = bootstrapMean(values, { level: 0.95 });
    const narrow = bootstrapMean(values, { level: 0.5 });
    expect(narrow.hi - narrow.lo).toBeLessThan(wide.hi - wide.lo);
  });

  it('covers the true mean about as often as it claims', () => {
    // 300 samples of 20 uniform values; the 95% interval should contain 0.5 most of the time.
    let covered = 0;
    const trials = 300;
    for (let t = 0; t < trials; t++) {
      const state = { s: t * 7919 + 1 };
      const next = (): number => {
        state.s = (state.s * 1103515245 + 12345) % 2147483648;
        return state.s / 2147483648;
      };
      const sample = Array.from({ length: 20 }, next);
      const { lo, hi } = bootstrapMean(sample, { resamples: 400, seed: t });
      if (lo <= 0.5 && hi >= 0.5) covered++;
    }
    expect(covered / trials).toBeGreaterThan(0.87);
    expect(covered / trials).toBeLessThanOrEqual(1);
  });

  it('ignores non-finite values and handles an empty sample', () => {
    expect(bootstrapMean([1, NaN, 3]).n).toBe(2);
    expect(bootstrapMean([1, NaN, 3]).mean).toBe(2);
    expect(bootstrapMean([]).mean).toBeNaN();
  });
});
