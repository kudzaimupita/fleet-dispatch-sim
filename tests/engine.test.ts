import { describe, expect, it } from 'vitest';
import { createPolicy, POLICY_NAMES } from '../src/policies/index.ts';
import { DEMAND_PATTERNS } from '../src/sim/demand.ts';
import { Simulation } from '../src/sim/engine.ts';
import { buildScenario, customScenario } from '../src/sim/scenario.ts';
import { checkInvariants, digest } from './helpers.ts';

const cases = POLICY_NAMES.flatMap((policy) =>
  DEMAND_PATTERNS.map((pattern) => ({ policy, pattern })),
);

describe('determinism', () => {
  it.each(cases)('$policy / $pattern: two runs are identical', ({ policy, pattern }) => {
    const run = (): string =>
      digest(new Simulation(buildScenario({ seed: 7, pattern }), createPolicy(policy)).run());
    expect(run()).toBe(run());
  });

  it.each(POLICY_NAMES)('%s: different seeds give different runs', (policy) => {
    const run = (seed: number): string =>
      digest(new Simulation(buildScenario({ seed }), createPolicy(policy)).run());
    expect(run(1)).not.toBe(run(2));
  });

  it.each(POLICY_NAMES)('%s: stepping the clock in slices matches one straight run', (policy) => {
    const scenario = buildScenario({ seed: 3, pattern: 'lunch', horizon: 3600 });
    const straight = new Simulation(scenario, createPolicy(policy)).run();
    const sliced = new Simulation(scenario, createPolicy(policy));
    // Uneven slices, as a browser's frame clock would produce.
    for (let t = 0; !sliced.done; t += 7.3) sliced.runUntil(t);
    expect(digest(sliced)).toBe(digest(straight));
  });

  it('does not let one run leak into the next on a shared scenario', () => {
    const scenario = buildScenario({ seed: 4 });
    const first = digest(new Simulation(scenario, createPolicy('batch')).run());
    new Simulation(scenario, createPolicy('nearest')).run();
    expect(digest(new Simulation(scenario, createPolicy('batch')).run())).toBe(first);
  });
});

describe('invariants on full runs', () => {
  it.each(cases)(
    '$policy / $pattern: consistent state, battery in range, every job accounted for',
    ({ policy, pattern }) => {
      // A small battery and a short patience make charging and drops frequent.
      const scenario = buildScenario({
        seed: 11,
        pattern,
        horizon: 5400,
        jobsPerHour: 140,
        batteryRange: 150,
        patience: 300,
      });
      const sim = new Simulation(scenario, createPolicy(policy));
      let last = 0;
      let charged = false;
      sim.onEvent = () => {
        expect(sim.now).toBeGreaterThanOrEqual(last);
        last = sim.now;
        charged ||= sim.robots.some((r) => r.phase === 'charging');
        checkInvariants(sim);
      };
      sim.run();

      expect(charged).toBe(true);
      expect(sim.done).toBe(true);
      const delivered = sim.jobs.filter((j) => j.status === 'delivered');
      const dropped = sim.jobs.filter((j) => j.status === 'dropped');
      expect(delivered.length + dropped.length).toBe(scenario.jobs.length);
      expect(dropped.length).toBeGreaterThan(0);
      expect(delivered.length).toBeGreaterThan(0);

      const { speed, loadTime, unloadTime, patience } = scenario.config;
      for (const job of delivered) {
        expect(job.pickedAt).not.toBeNull();
        expect(job.pickedAt!).toBeGreaterThanOrEqual(job.release);
        expect(job.pickedAt!).toBeLessThanOrEqual(job.release + patience);
        const carry = scenario.map.distance(job.pickup, job.dropoff) / speed;
        expect(job.deliveredAt!).toBeCloseTo(job.pickedAt! + loadTime + carry + unloadTime, 6);
        expect(job.droppedAt).toBeNull();
      }
      for (const job of dropped) {
        expect(job.pickedAt).toBeNull();
        expect(job.deliveredAt).toBeNull();
        expect(job.droppedAt).toBe(job.release + patience);
      }
      // Capacity of one: a robot's deliveries never overlap in time.
      for (const robot of sim.robots) {
        const mine = delivered
          .filter((j) => j.robotId === robot.id)
          .sort((a, b) => a.pickedAt! - b.pickedAt!);
        for (let i = 1; i < mine.length; i++) {
          expect(mine[i]!.pickedAt!).toBeGreaterThanOrEqual(mine[i - 1]!.deliveredAt!);
        }
      }
    },
  );

  it.each(POLICY_NAMES)('%s: default config over several seeds', (policy) => {
    for (let seed = 20; seed < 24; seed++) {
      const scenario = buildScenario({ seed, pattern: 'lunch', horizon: 7200 });
      const sim = new Simulation(scenario, createPolicy(policy));
      let events = 0;
      sim.onEvent = () => {
        events++;
        checkInvariants(sim);
      };
      sim.run();
      const resolved = sim.jobs.filter((j) => j.status === 'delivered' || j.status === 'dropped');
      expect(resolved.length).toBe(scenario.jobs.length);
      expect(events).toBe(sim.eventsProcessed);
    }
  });
});

describe('job lifecycle', () => {
  const grid = { width: 10, height: 10, chargers: [[0, 0]] as const };

  it('delivers a single job with exact timing', () => {
    const scenario = customScenario({
      ...grid,
      robots: [{ at: [0, 0] }],
      jobs: [{ pickup: [4, 0], dropoff: [4, 6], release: 10 }],
      config: { speed: 0.5, loadTime: 5, unloadTime: 7 },
    });
    const sim = new Simulation(scenario, createPolicy('nearest')).run();
    const job = sim.jobs[0]!;
    expect(job.status).toBe('delivered');
    expect(job.pickedAt).toBe(10 + 4 / 0.5);
    expect(job.deliveredAt).toBe(18 + 5 + 6 / 0.5 + 7);
    const robot = sim.robots[0]!;
    expect(robot.distanceEmpty).toBe(4);
    expect(robot.distanceLoaded).toBe(6);
    expect(robot.battery).toBe(scenario.config.batteryRange - 10);
    expect(robot.busyTime).toBe(job.deliveredAt! - 10);
    expect(sim.now).toBe(job.deliveredAt);
  });

  it('picks up at once when the robot is already at the pickup', () => {
    const scenario = customScenario({
      ...grid,
      robots: [{ at: [3, 3] }],
      jobs: [{ pickup: [3, 3], dropoff: [3, 4], release: 2 }],
    });
    const sim = new Simulation(scenario, createPolicy('fifo')).run();
    expect(sim.jobs[0]!.pickedAt).toBe(2);
  });

  it('drops a job nobody reaches in time and frees the robot', () => {
    const scenario = customScenario({
      ...grid,
      robots: [{ at: [0, 0] }],
      jobs: [
        { pickup: [9, 9], dropoff: [0, 9], release: 0 },
        { pickup: [5, 0], dropoff: [6, 0], release: 100 },
      ],
      config: { speed: 0.25, patience: 30 },
    });
    const sim = new Simulation(scenario, createPolicy('nearest'));
    sim.onEvent = () => {
      checkInvariants(sim);
    };
    sim.run();
    expect(sim.jobs[0]!.status).toBe('dropped');
    expect(sim.jobs[0]!.droppedAt).toBe(30);
    expect(sim.jobs[0]!.robotId).toBeNull();
    // The robot abandoned the first trip at a cell boundary and took the second job.
    expect(sim.jobs[1]!.status).toBe('delivered');
    expect(sim.jobs[1]!.robotId).toBe(0);
  });

  it('ends immediately when there are no jobs', () => {
    const scenario = customScenario({ ...grid, robots: [{ at: [1, 1] }], jobs: [] });
    const sim = new Simulation(scenario, createPolicy('batch'));
    expect(sim.done).toBe(true);
    expect(sim.step()).toBe(false);
    sim.runUntil(100);
    expect(sim.now).toBe(0);
  });
});

describe('charging rule', () => {
  const grid = { width: 12, height: 6, chargers: [[0, 0]] as const };

  it.each(POLICY_NAMES)('%s: a robot short of range charges first, then serves', (policy) => {
    const scenario = customScenario({
      ...grid,
      robots: [{ at: [2, 0], battery: 12 }],
      // Needs 9 + 5 to do the job, 16 to get back to the charger, plus the reserve.
      jobs: [{ pickup: [11, 0], dropoff: [11, 5], release: 0 }],
      config: { batteryRange: 100, chargeRate: 2, reserve: 5, patience: 5000, lowBattery: 0 },
    });
    const sim = new Simulation(scenario, createPolicy(policy));
    const phases = new Set<string>();
    sim.onEvent = () => {
      phases.add(sim.robots[0]!.phase);
      checkInvariants(sim);
    };
    sim.run();
    expect(phases.has('charging')).toBe(true);
    const job = sim.jobs[0]!;
    expect(job.status).toBe('delivered');
    // Drive 2 to the charger, charge from 10 to 100 at 2 per second, then drive 11.
    // The batch policy only acts on its 10-second ticks, so it sets off at 60.
    const charged = 2 / 0.25 + 45;
    const setOff = policy === 'batch' ? Math.ceil(charged / 10) * 10 : charged;
    expect(job.pickedAt).toBe(setOff + 11 / 0.25);
  });

  it('never assigns a job that would strand the robot', () => {
    const scenario = customScenario({
      ...grid,
      robots: [{ at: [0, 0], battery: 20 }],
      // Out of range even on a full battery: 16 + 16 back + 16 to the charger + reserve.
      jobs: [{ pickup: [11, 5], dropoff: [0, 0], release: 0 }],
      config: { batteryRange: 30, reserve: 5, patience: 200 },
    });
    const sim = new Simulation(scenario, createPolicy('nearest')).run();
    expect(sim.jobs[0]!.status).toBe('dropped');
    expect(sim.robots[0]!.distanceEmpty).toBe(0);
  });

  it('sends a low robot to charge once it is idle', () => {
    const scenario = customScenario({
      ...grid,
      robots: [{ at: [1, 0], battery: 40 }],
      jobs: [
        { pickup: [2, 0], dropoff: [8, 0], release: 0 },
        { pickup: [8, 1], dropoff: [9, 1], release: 2000 },
      ],
      config: { batteryRange: 100, lowBattery: 0.4, chargeRate: 1, patience: 5000 },
    });
    const sim = new Simulation(scenario, createPolicy('fifo'));
    sim.runUntil(1000);
    const robot = sim.robots[0]!;
    // 40 - 7 for the job - 8 back to the charger = 25, then a full charge.
    expect(sim.jobs[0]!.status).toBe('delivered');
    expect(robot.phase).toBe('idle');
    expect(robot.cell).toBe(scenario.chargers[0]);
    expect(robot.battery).toBe(100);
    expect(robot.distanceEmpty).toBe(1 + 8);
  });

  it('queues robots when every bay is taken', () => {
    const scenario = customScenario({
      ...grid,
      robots: [
        { at: [1, 0], battery: 10 },
        { at: [2, 0], battery: 10 },
        { at: [3, 0], battery: 10 },
      ],
      jobs: [{ pickup: [5, 5], dropoff: [6, 5], release: 0 }],
      config: { batteryRange: 100, chargeRate: 1, chargerBays: 1, lowBattery: 0.5, patience: 9000 },
    });
    const sim = new Simulation(scenario, createPolicy('nearest'));
    let longestQueue = 0;
    sim.onEvent = () => {
      longestQueue = Math.max(longestQueue, sim.stations[0]!.waiting.length);
      checkInvariants(sim);
    };
    sim.run();
    expect(longestQueue).toBe(2);
    expect(sim.jobs[0]!.status).toBe('delivered');
    // The first robot to arrive charges first and takes the job.
    expect(sim.jobs[0]!.robotId).toBe(0);
  });

  it('reports the charge gained so far while on a charger', () => {
    const scenario = customScenario({
      ...grid,
      robots: [{ at: [0, 0], battery: 10 }],
      jobs: [{ pickup: [5, 5], dropoff: [6, 5], release: 0 }],
      config: { batteryRange: 100, chargeRate: 2, lowBattery: 0.5, patience: 9000 },
    });
    const sim = new Simulation(scenario, createPolicy('nearest'));
    sim.runUntil(20);
    expect(sim.robots[0]!.phase).toBe('charging');
    expect(sim.batteryOf(sim.robots[0]!)).toBe(50);
    sim.runUntil(45);
    expect(sim.robots[0]!.phase).not.toBe('charging');
  });
});

describe('dispatch commands', () => {
  it('rejects an assignment the charging rule forbids', () => {
    const scenario = customScenario({
      width: 6,
      height: 6,
      chargers: [[0, 0]],
      robots: [{ at: [0, 0] }, { at: [5, 5] }],
      jobs: [
        { pickup: [1, 0], dropoff: [2, 0], release: 0 },
        { pickup: [3, 0], dropoff: [4, 0], release: 0 },
      ],
    });
    const errors: string[] = [];
    const sim = new Simulation(scenario, {
      name: 'careless',
      dispatch(ctx) {
        const [first, second] = ctx.pending();
        if (first === undefined || second === undefined) return;
        ctx.assign(0, first.id);
        ctx.assign(0, second.id); // chained: allowed
        for (const attempt of [
          () => {
            ctx.assign(0, second.id); // already assigned
          },
          () => {
            ctx.assign(7, first.id); // no such robot
          },
          () => {
            ctx.unassign(99); // no such job
          },
        ]) {
          try {
            attempt();
          } catch (error) {
            errors.push((error as Error).message);
          }
        }
      },
    });
    sim.onEvent = () => {
      checkInvariants(sim);
    };
    sim.run();
    expect(errors.length).toBe(3);
    expect(sim.jobs.map((j) => [j.status, j.robotId])).toEqual([
      ['delivered', 0],
      ['delivered', 0],
    ]);
  });

  it('moves the chained job up when the current one is taken back', () => {
    const scenario = customScenario({
      width: 8,
      height: 2,
      chargers: [[0, 0]],
      robots: [{ at: [0, 0] }],
      jobs: [
        { pickup: [7, 0], dropoff: [7, 1], release: 0 },
        { pickup: [2, 1], dropoff: [3, 1], release: 0 },
      ],
    });
    let changedMind = false;
    const sim = new Simulation(scenario, {
      name: 'fickle',
      dispatch(ctx) {
        // Both jobs are released at t=0, as two events; wait for the second.
        if (!changedMind && ctx.pending().length === 2) {
          changedMind = true;
          ctx.assign(0, 0);
          ctx.assign(0, 1);
          ctx.unassign(0);
        } else if (changedMind) {
          for (const job of ctx.pending()) {
            const robot = ctx.robots[0]!;
            if (ctx.canAssign(robot, job)) ctx.assign(0, job.id);
          }
        }
      },
    });
    sim.onEvent = () => {
      checkInvariants(sim);
    };
    sim.run();
    expect(sim.jobs[1]!.pickedAt!).toBeLessThan(sim.jobs[0]!.pickedAt!);
    expect(sim.jobs.every((j) => j.status === 'delivered')).toBe(true);
  });
});
