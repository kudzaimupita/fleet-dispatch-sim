import type { Simulation } from './engine.ts';

export interface Metrics {
  jobs: number;
  delivered: number;
  dropped: number;
  /** Released but neither delivered nor dropped yet (zero once a run is over). */
  open: number;
  /** Seconds from release to the robot reaching the pickup, over picked-up jobs. */
  waitP50: number;
  waitP95: number;
  /** Jobs delivered by their deadline, as a share of delivered plus dropped. */
  onTimeRate: number;
  /** Distance driven without a parcel (to pickups and to chargers) over all distance. */
  deadheadShare: number;
  /** Share of fleet time spent on jobs: to pickup, loading, carrying, unloading. */
  utilisation: number;
  distance: number;
  /** Simulated seconds covered. */
  elapsed: number;
}

/**
 * Percentile with linear interpolation between order statistics (the common
 * "type 7" definition). NaN for an empty sample.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(Math.max(p, 0), 100) / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/** Metrics so far. Valid at any point in a run, not only at the end. */
export function computeMetrics(sim: Simulation): Metrics {
  const waits: number[] = [];
  let delivered = 0;
  let dropped = 0;
  let open = 0;
  let onTime = 0;
  for (const job of sim.jobs) {
    if (job.pickedAt !== null) waits.push(job.pickedAt - job.release);
    if (job.status === 'delivered') {
      delivered++;
      if (job.deliveredAt! <= job.deadline) onTime++;
    } else if (job.status === 'dropped') dropped++;
    else if (job.status !== 'future') open++;
  }
  let loaded = 0;
  let empty = 0;
  let busy = 0;
  for (const robot of sim.robots) {
    loaded += robot.distanceLoaded;
    empty += robot.distanceEmpty;
    busy += robot.busyTime + (robot.busySince === null ? 0 : sim.now - robot.busySince);
  }
  const distance = loaded + empty;
  const resolved = delivered + dropped;
  const fleetTime = sim.robots.length * sim.now;
  return {
    jobs: sim.jobs.length,
    delivered,
    dropped,
    open,
    waitP50: percentile(waits, 50),
    waitP95: percentile(waits, 95),
    onTimeRate: resolved === 0 ? NaN : onTime / resolved,
    deadheadShare: distance === 0 ? NaN : empty / distance,
    utilisation: fleetTime === 0 ? NaN : busy / fleetTime,
    distance,
    elapsed: sim.now,
  };
}
