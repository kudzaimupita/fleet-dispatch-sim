import type { DispatchContext, DispatchPolicy } from './types.ts';

/**
 * Nearest idle robot: repeatedly commit the closest (idle robot, waiting job)
 * pair. A new job gets the nearest idle robot; a robot that becomes idle takes
 * the nearest waiting job, however long other jobs have waited.
 */
export function nearestIdlePolicy(): DispatchPolicy {
  return {
    name: 'nearest',
    dispatch(ctx: DispatchContext): void {
      const jobs = ctx.pending();
      const robots = ctx.robots.filter((r) => r.phase === 'idle');
      while (jobs.length > 0 && robots.length > 0) {
        let best: { r: number; j: number; distance: number } | null = null;
        for (let r = 0; r < robots.length; r++) {
          const robot = robots[r]!;
          const free = ctx.availability(robot);
          if (free === null) continue;
          for (let j = 0; j < jobs.length; j++) {
            const job = jobs[j]!;
            if (!ctx.canAssign(robot, job)) continue;
            const distance = ctx.distance(free.cell, job.pickup);
            // Strict "<" keeps the oldest job, then the lowest robot id, on ties.
            if (best === null || distance < best.distance) best = { r, j, distance };
          }
        }
        if (best === null) return;
        ctx.assign(robots[best.r]!.id, jobs[best.j]!.id);
        robots.splice(best.r, 1);
        jobs.splice(best.j, 1);
      }
    },
  };
}
