import { solveAssignment } from './hungarian.ts';
import type { DispatchContext, DispatchPolicy } from './types.ts';

export interface BatchOptions {
  /** Seconds between re-solves. */
  interval?: number;
  /**
   * Seconds of pickup ETA a job is worth per second it has already waited.
   * Zero (the default) minimises total time-to-pickup; a positive value pulls
   * older jobs forward at the cost of longer drives.
   */
  ageWeight?: number;
}

/**
 * Batch assignment: every `interval` seconds, take back every job that has
 * not been picked up and solve one robot-to-job assignment over all of them.
 *
 * The cost of a pair is the time until that robot could be at the pickup
 * (finishing its current delivery first, if it has one), optionally minus a
 * credit for how long the job has waited. Nothing is assigned between solves.
 */
export function batchPolicy(options: BatchOptions = {}): DispatchPolicy {
  const interval = options.interval ?? 10;
  const ageWeight = options.ageWeight ?? 0;
  return {
    name: 'batch',
    tickInterval: interval,
    dispatch(ctx: DispatchContext): void {
      if (ctx.trigger !== 'tick') return;
      for (const job of ctx.assigned()) ctx.unassign(job.id);
      const jobs = ctx.pending();
      if (jobs.length === 0) return;
      const robots = ctx.robots.filter((robot) => ctx.availability(robot) !== null);
      if (robots.length === 0) return;
      const cost = robots.map((robot) => {
        const free = ctx.availability(robot)!;
        return jobs.map((job) => {
          if (!ctx.canAssign(robot, job)) return Infinity;
          const eta = free.time - ctx.now + ctx.distance(free.cell, job.pickup) / ctx.speed;
          return eta - ageWeight * (ctx.now - job.release);
        });
      });
      const { assignment } = solveAssignment(cost);
      assignment.forEach((column, row) => {
        if (column >= 0) ctx.assign(robots[row]!.id, jobs[column]!.id);
      });
    },
  };
}
