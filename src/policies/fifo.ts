import type { DispatchContext, DispatchPolicy } from './types.ts';

/**
 * First-come queue: jobs are served strictly oldest first. The oldest waiting
 * job gets the nearest idle robot that can take it. A job no idle robot has
 * the range for is skipped rather than holding up the queue.
 */
export function fifoPolicy(): DispatchPolicy {
  return {
    name: 'fifo',
    dispatch(ctx: DispatchContext): void {
      for (const job of ctx.pending()) {
        let bestId = -1;
        let bestDistance = Infinity;
        for (const robot of ctx.robots) {
          if (robot.phase !== 'idle' || !ctx.canAssign(robot, job)) continue;
          const free = ctx.availability(robot);
          if (free === null) continue;
          const distance = ctx.distance(free.cell, job.pickup);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestId = robot.id;
          }
        }
        if (bestId >= 0) ctx.assign(bestId, job.id);
      }
    },
  };
}
