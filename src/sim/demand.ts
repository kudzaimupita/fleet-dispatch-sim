import type { Rng } from './rng.ts';
import type { Cell, RoadMap } from './road-map.ts';

export const DEMAND_PATTERNS = ['uniform', 'lunch', 'hotspot'] as const;
export type DemandPattern = (typeof DEMAND_PATTERNS)[number];

export interface Job {
  /** Jobs are numbered in release order, starting at zero. */
  readonly id: number;
  readonly pickup: Cell;
  readonly dropoff: Cell;
  /** Time the job becomes known to the dispatcher, in seconds. */
  readonly release: number;
  /** Promised delivery time, in seconds. */
  readonly deadline: number;
}

export interface DemandOptions {
  pattern: DemandPattern;
  /** Jobs are released in [0, horizon). Seconds. */
  horizon: number;
  /** Mean arrival rate over the horizon. The patterns reshape it, not rescale it. */
  jobsPerHour: number;
  /** Robot speed in cells per second, used to set deadlines. */
  speed: number;
  /** Deadline = release + deadlineSlack + deadlineFactor * direct travel time. */
  deadlineSlack: number;
  deadlineFactor: number;
}

/** Share of hot-spot pickups that come from around a hot centre. */
const HOTSPOT_SHARE = 0.7;
const HOTSPOT_CENTRES = 2;
const HOTSPOT_RADIUS = 4;

/**
 * Relative arrival intensity at `u` = time / horizon. Only 'lunch' varies in
 * time: a low base rate with a bell-shaped peak in the middle of the run.
 */
export function intensityShape(pattern: DemandPattern, u: number): number {
  if (pattern !== 'lunch') return 1;
  const z = (u - 0.5) / 0.12;
  return 0.5 + 1.5 * Math.exp(-0.5 * z * z);
}

function shapeStats(pattern: DemandPattern): { mean: number; max: number } {
  const steps = 2000;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < steps; i++) {
    const s = intensityShape(pattern, (i + 0.5) / steps);
    sum += s;
    max = Math.max(max, s);
  }
  return { mean: sum / steps, max };
}

/**
 * Generate the job list for a run: a non-homogeneous Poisson process, sampled
 * by thinning, with pickup and drop-off cells drawn according to the pattern.
 */
export function generateJobs(rng: Rng, map: RoadMap, options: DemandOptions): Job[] {
  const free = map.freeCells;
  if (free.length < 2) throw new Error('the map needs at least two free cells');
  const { pattern, horizon } = options;
  const { mean, max } = shapeStats(pattern);
  const meanRate = options.jobsPerHour / 3600;
  const peakRate = (meanRate * max) / mean;

  let hotCells: Cell[] = [];
  if (pattern === 'hotspot') {
    const centres: Cell[] = [];
    for (let i = 0; i < HOTSPOT_CENTRES; i++) centres.push(rng.pick(free));
    hotCells = free.filter((c) => centres.some((h) => map.distance(c, h) <= HOTSPOT_RADIUS));
  }

  const jobs: Job[] = [];
  if (peakRate <= 0) return jobs;
  let t = 0;
  for (;;) {
    t += rng.exponential(peakRate);
    if (t >= horizon) break;
    const accept = rng.next() * max < intensityShape(pattern, t / horizon);
    if (!accept) continue;
    const pickup =
      hotCells.length > 0 && rng.next() < HOTSPOT_SHARE ? rng.pick(hotCells) : rng.pick(free);
    let dropoff = rng.pick(free);
    while (dropoff === pickup) dropoff = rng.pick(free);
    const direct = map.distance(pickup, dropoff) / options.speed;
    jobs.push({
      id: jobs.length,
      pickup,
      dropoff,
      release: t,
      deadline: t + options.deadlineSlack + options.deadlineFactor * direct,
    });
  }
  return jobs;
}
