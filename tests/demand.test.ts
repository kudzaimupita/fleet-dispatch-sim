import { describe, expect, it } from 'vitest';
import { DEMAND_PATTERNS, generateJobs, intensityShape } from '../src/sim/demand.ts';
import { Rng } from '../src/sim/rng.ts';
import { generateCity } from '../src/sim/road-map.ts';
import { buildScenario, customScenario } from '../src/sim/scenario.ts';

const options = {
  horizon: 4 * 3600,
  jobsPerHour: 100,
  speed: 0.25,
  deadlineSlack: 180,
  deadlineFactor: 2,
};

describe('generateJobs', () => {
  const map = generateCity(new Rng(1), { width: 28, height: 19 });

  it.each(DEMAND_PATTERNS)('%s: jobs are well formed and in release order', (pattern) => {
    const jobs = generateJobs(new Rng(9), map, { ...options, pattern });
    expect(jobs.length).toBeGreaterThan(300);
    jobs.forEach((job, i) => {
      expect(job.id).toBe(i);
      expect(job.release).toBeGreaterThanOrEqual(0);
      expect(job.release).toBeLessThan(options.horizon);
      if (i > 0) expect(job.release).toBeGreaterThanOrEqual(jobs[i - 1]!.release);
      expect(map.isFree(job.pickup)).toBe(true);
      expect(map.isFree(job.dropoff)).toBe(true);
      expect(job.pickup).not.toBe(job.dropoff);
      const direct = map.distance(job.pickup, job.dropoff) / options.speed;
      expect(job.deadline).toBeCloseTo(job.release + 180 + 2 * direct, 9);
    });
  });

  it.each(DEMAND_PATTERNS)('%s: the mean rate is the configured one', (pattern) => {
    let total = 0;
    const runs = 40;
    for (let seed = 0; seed < runs; seed++) {
      total += generateJobs(new Rng(seed), map, { ...options, pattern }).length;
    }
    // 400 expected per run; the mean of 40 Poisson runs has a standard error of about 3.
    expect(Math.abs(total / runs - 400)).toBeLessThan(12);
  });

  it('is deterministic for a seed', () => {
    const a = generateJobs(new Rng(3), map, { ...options, pattern: 'hotspot' });
    const b = generateJobs(new Rng(3), map, { ...options, pattern: 'hotspot' });
    expect(a).toEqual(b);
    const c = generateJobs(new Rng(4), map, { ...options, pattern: 'hotspot' });
    expect(a).not.toEqual(c);
  });

  it('lunch concentrates arrivals in the middle of the run', () => {
    const share = (pattern: 'uniform' | 'lunch'): number => {
      let middle = 0;
      let all = 0;
      for (let seed = 0; seed < 20; seed++) {
        for (const job of generateJobs(new Rng(seed), map, { ...options, pattern })) {
          all++;
          const u = job.release / options.horizon;
          if (u > 0.35 && u < 0.65) middle++;
        }
      }
      return middle / all;
    };
    expect(share('uniform')).toBeGreaterThan(0.27);
    expect(share('uniform')).toBeLessThan(0.33);
    expect(share('lunch')).toBeGreaterThan(0.5);
    expect(intensityShape('lunch', 0.5)).toBeGreaterThan(3 * intensityShape('lunch', 0));
  });

  it('hotspot concentrates pickups but not drop-offs', () => {
    const topShare = (cells: number[]): number => {
      const counts = new Map<number, number>();
      for (const c of cells) counts.set(c, (counts.get(c) ?? 0) + 1);
      const sorted = [...counts.values()].sort((a, b) => b - a);
      const top = sorted.slice(0, Math.ceil(map.freeCells.length * 0.15));
      return top.reduce((a, b) => a + b, 0) / cells.length;
    };
    const hot = generateJobs(new Rng(2), map, {
      ...options,
      pattern: 'hotspot',
      jobsPerHour: 1000,
    });
    const flat = generateJobs(new Rng(2), map, {
      ...options,
      pattern: 'uniform',
      jobsPerHour: 1000,
    });
    expect(topShare(hot.map((j) => j.pickup))).toBeGreaterThan(0.6);
    expect(topShare(flat.map((j) => j.pickup))).toBeLessThan(0.35);
    expect(topShare(hot.map((j) => j.dropoff))).toBeLessThan(0.35);
  });

  it('produces no jobs at a zero rate', () => {
    expect(
      generateJobs(new Rng(1), map, { ...options, pattern: 'uniform', jobsPerHour: 0 }),
    ).toEqual([]);
  });
});

describe('buildScenario', () => {
  it('is a pure function of the config', () => {
    const a = buildScenario({ seed: 12, pattern: 'lunch' });
    const b = buildScenario({ seed: 12, pattern: 'lunch' });
    expect(a.jobs).toEqual(b.jobs);
    expect(a.robots).toEqual(b.robots);
    expect(a.chargers).toEqual(b.chargers);
    expect([...a.map.blocked]).toEqual([...b.map.blocked]);
  });

  it('keeps the map and the demand when the fleet size changes', () => {
    const small = buildScenario({ seed: 5, robots: 3 });
    const large = buildScenario({ seed: 5, robots: 9 });
    expect(large.jobs).toEqual(small.jobs);
    expect([...large.map.blocked]).toEqual([...small.map.blocked]);
    expect(large.robots.slice(0, 3)).toEqual(small.robots);
  });

  it('places robots and chargers on free cells with a sensible charge', () => {
    const s = buildScenario({ seed: 8, robots: 10 });
    expect(s.chargers.length).toBe(s.config.chargers);
    for (const c of s.chargers) expect(s.map.isFree(c)).toBe(true);
    for (const r of s.robots) {
      expect(s.map.isFree(r.cell)).toBe(true);
      expect(r.battery).toBeGreaterThanOrEqual(0.6 * s.config.batteryRange);
      expect(r.battery).toBeLessThanOrEqual(s.config.batteryRange);
    }
  });

  it('rejects nonsense config', () => {
    expect(() => buildScenario({ robots: 0 })).toThrow(/robots/);
    expect(() => buildScenario({ speed: -1 })).toThrow(/speed/);
    expect(() => buildScenario({ lowBattery: 1 })).toThrow(/lowBattery/);
    expect(() => buildScenario({ jobsPerHour: -5 })).toThrow(/jobsPerHour/);
  });
});

describe('customScenario', () => {
  it('numbers jobs in release order and rejects blocked cells', () => {
    const s = customScenario({
      width: 4,
      height: 4,
      blocked: [[1, 1]],
      chargers: [[0, 0]],
      robots: [{ at: [3, 3] }],
      jobs: [
        { pickup: [0, 1], dropoff: [3, 0], release: 50 },
        { pickup: [2, 2], dropoff: [0, 3], release: 10 },
      ],
    });
    expect(s.jobs.map((j) => j.release)).toEqual([10, 50]);
    expect(s.jobs.map((j) => j.id)).toEqual([0, 1]);
    expect(() =>
      customScenario({
        width: 4,
        height: 4,
        blocked: [[1, 1]],
        chargers: [[1, 1]],
        robots: [{ at: [0, 0] }],
        jobs: [],
      }),
    ).toThrow(/not a free cell/);
  });
});
