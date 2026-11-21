import type { DispatchContext, DispatchPolicy } from './types.ts';

/**
 * Queue with chaining: oldest job first, but a robot that is already carrying
 * a parcel is a candidate too, measured from where it will drop off. The job
 * goes to the candidate with the least empty travel to the pickup, so a robot
 * about to finish next door is preferred to an idle one across town. Each
 * robot holds at most one chained job.
 *
 * Ties go to the robot that can reach the pickup sooner, then the lower id.
 */
export function chainPolicy(): DispatchPolicy {
  return {
    name: 'chain',
    dispatch(ctx: DispatchContext): void {
      for (const job of ctx.pending()) {
        let bestId = -1;
        let bestEmpty = Infinity;
        let bestEta = Infinity;
        for (const robot of ctx.robots) {
          // A robot still driving to a pickup is not chained: its plan can change.
          if (robot.phase === 'to_pickup' || !ctx.canAssign(robot, job)) continue;
          const free = ctx.availability(robot);
          if (free === null) continue;
          const empty = ctx.distance(free.cell, job.pickup);
          const eta = free.time + empty / ctx.speed;
          if (empty < bestEmpty || (empty === bestEmpty && eta < bestEta)) {
            bestEmpty = empty;
            bestEta = eta;
            bestId = robot.id;
          }
        }
        if (bestId >= 0) ctx.assign(bestId, job.id);
      }
    },
  };
}
