import type { Simulation } from '../src/sim/engine.ts';

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`invariant broken: ${message}`);
}

/**
 * Structural checks that must hold after every single event. Plain throws
 * rather than `expect`, because this runs hundreds of thousands of times.
 */
export function checkInvariants(sim: Simulation): void {
  const holders = new Map<number, number>();
  const hold = (jobId: number, robotId: number): void => {
    check(!holders.has(jobId), `job ${jobId} is held twice`);
    holders.set(jobId, robotId);
  };

  for (const robot of sim.robots) {
    const battery = sim.batteryOf(robot);
    check(battery >= 0, `robot ${robot.id} battery ${battery} is negative`);
    check(battery <= sim.config.batteryRange, `robot ${robot.id} is over-charged`);
    check(sim.map.isFree(robot.cell), `robot ${robot.id} is inside a building`);
    if (robot.moving !== null) {
      check(sim.map.neighbours(robot.cell).includes(robot.moving.to), 'segment is not a road');
    }

    if (robot.jobId !== null) {
      const job = sim.jobs[robot.jobId]!;
      hold(job.id, robot.id);
      check(job.robotId === robot.id, `job ${job.id} does not point back at robot ${robot.id}`);
      if (robot.phase === 'to_pickup') check(job.status === 'assigned', 'to_pickup needs assigned');
      else {
        check(['loading', 'to_dropoff', 'unloading'].includes(robot.phase), `phase ${robot.phase}`);
        check(job.status === 'carried', `job ${job.id} should be carried`);
      }
    } else {
      check(
        ['idle', 'to_charger', 'queued', 'charging'].includes(robot.phase),
        `robot ${robot.id} is ${robot.phase} without a job`,
      );
    }
    if (robot.nextJobId !== null) {
      const next = sim.jobs[robot.nextJobId]!;
      hold(next.id, robot.id);
      check(robot.jobId !== null, 'a next job needs a current job');
      check(next.status === 'assigned' && next.robotId === robot.id, 'next job is inconsistent');
    }
  }

  for (const job of sim.jobs) {
    const held = job.status === 'assigned' || job.status === 'carried';
    check(holders.has(job.id) === held, `job ${job.id} (${job.status}) holder mismatch`);
    if (job.status === 'future') check(job.release >= sim.now, `job ${job.id} was not released`);
    if (job.status === 'pending') check(job.robotId === null, `pending job ${job.id} has a robot`);
  }

  for (const station of sim.stations) {
    check(station.charging.length <= station.bays, `station ${station.id} is over capacity`);
    for (const id of station.charging) check(sim.robots[id]!.phase === 'charging', 'bay mismatch');
    for (const id of station.waiting) check(sim.robots[id]!.phase === 'queued', 'queue mismatch');
    if (station.waiting.length > 0) {
      check(station.charging.length === station.bays, 'robots wait while a bay is free');
    }
  }
}

/** A compact fingerprint of everything that happened to the jobs and robots. */
export function digest(sim: Simulation): string {
  return JSON.stringify({
    end: sim.now,
    events: sim.eventsProcessed,
    jobs: sim.jobs.map((j) => [j.status, j.robotId, j.pickedAt, j.deliveredAt, j.droppedAt]),
    robots: sim.robots.map((r) => [r.cell, r.battery, r.distanceLoaded, r.distanceEmpty]),
  });
}
