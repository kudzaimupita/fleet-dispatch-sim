import { describe, expect, it } from 'vitest';
import {
  batchPolicy,
  createPolicy,
  isPolicyName,
  POLICY_NAMES,
  type DispatchPolicy,
} from '../src/policies/index.ts';
import { Simulation } from '../src/sim/engine.ts';
import { computeMetrics } from '../src/sim/metrics.ts';
import { buildScenario, customScenario, type CustomScenario } from '../src/sim/scenario.ts';

const open = { width: 10, height: 10, chargers: [[0, 9]] as const };
const patient = { patience: 100000 };

function run(spec: CustomScenario, policy: DispatchPolicy): Simulation {
  return new Simulation(customScenario(spec), policy).run();
}

describe('policy registry', () => {
  it('creates every named policy', () => {
    for (const name of POLICY_NAMES) expect(createPolicy(name).name).toBe(name);
    expect(isPolicyName('batch')).toBe(true);
    expect(isPolicyName('random')).toBe(false);
  });

  it('only the batch policy asks for ticks', () => {
    expect(createPolicy('batch', { batch: { interval: 30 } }).tickInterval).toBe(30);
    for (const name of ['nearest', 'fifo', 'chain'] as const) {
      expect(createPolicy(name).tickInterval).toBeUndefined();
    }
  });
});

describe('nearest idle robot', () => {
  it('sends the closest idle robot', () => {
    const sim = run(
      {
        ...open,
        robots: [{ at: [0, 0] }, { at: [9, 9] }, { at: [5, 5] }],
        jobs: [{ pickup: [8, 9], dropoff: [8, 0], release: 0 }],
      },
      createPolicy('nearest'),
    );
    expect(sim.jobs[0]!.robotId).toBe(1);
    expect(sim.robots[1]!.distanceEmpty).toBe(1);
  });

  it('a freed robot takes the nearest waiting job, not the oldest', () => {
    const sim = run(
      {
        ...open,
        robots: [{ at: [0, 0] }],
        jobs: [
          { pickup: [0, 1], dropoff: [0, 5], release: 0 },
          { pickup: [9, 9], dropoff: [9, 8], release: 1 },
          { pickup: [0, 6], dropoff: [1, 6], release: 2 },
        ],
        config: patient,
      },
      createPolicy('nearest'),
    );
    expect(sim.jobs[2]!.pickedAt!).toBeLessThan(sim.jobs[1]!.pickedAt!);
  });
});

describe('first-come queue', () => {
  it('a freed robot takes the oldest waiting job, not the nearest', () => {
    const sim = run(
      {
        ...open,
        robots: [{ at: [0, 0] }],
        jobs: [
          { pickup: [0, 1], dropoff: [0, 5], release: 0 },
          { pickup: [9, 9], dropoff: [9, 8], release: 1 },
          { pickup: [0, 6], dropoff: [1, 6], release: 2 },
        ],
        config: patient,
      },
      createPolicy('fifo'),
    );
    expect(sim.jobs[1]!.pickedAt!).toBeLessThan(sim.jobs[2]!.pickedAt!);
  });

  it('serves a saturated queue in release order', () => {
    const scenario = buildScenario({
      seed: 2,
      robots: 1,
      jobsPerHour: 60,
      horizon: 3600,
      patience: 1e6,
    });
    const sim = new Simulation(scenario, createPolicy('fifo')).run();
    const robot = sim.robots[0]!;
    expect(robot.distanceLoaded).toBeGreaterThan(0);
    const picked = sim.jobs.map((j) => j.pickedAt!);
    for (let i = 1; i < picked.length; i++) expect(picked[i]!).toBeGreaterThan(picked[i - 1]!);
  });

  it('gives the oldest job the nearest of several idle robots', () => {
    const sim = run(
      {
        ...open,
        robots: [{ at: [0, 0] }, { at: [6, 6] }],
        jobs: [{ pickup: [6, 4], dropoff: [0, 4], release: 0 }],
      },
      createPolicy('fifo'),
    );
    expect(sim.jobs[0]!.robotId).toBe(1);
  });
});

describe('queue with chaining', () => {
  const spec: CustomScenario = {
    ...open,
    robots: [{ at: [0, 0] }, { at: [9, 0] }],
    jobs: [
      { pickup: [0, 0], dropoff: [0, 8], release: 0 },
      // Next to where robot 0 will drop off, far from idle robot 1.
      { pickup: [1, 8], dropoff: [5, 5], release: 5 },
    ],
    config: patient,
  };

  it('chains the job onto the robot that will finish next to it', () => {
    const chained = run(spec, createPolicy('chain'));
    expect(chained.jobs[1]!.robotId).toBe(0);
    const queued = run(spec, createPolicy('fifo'));
    expect(queued.jobs[1]!.robotId).toBe(1);
    const empty = (sim: Simulation): number =>
      sim.robots.reduce((sum, r) => sum + r.distanceEmpty, 0);
    expect(empty(chained)).toBe(1);
    expect(empty(queued)).toBe(16);
  });

  it('holds at most one chained job per robot and never chains onto an empty robot', () => {
    const scenario = buildScenario({ seed: 6, pattern: 'lunch', horizon: 3600, jobsPerHour: 200 });
    const sim = new Simulation(scenario, createPolicy('chain'));
    let chainedSeen = 0;
    const badPhases = new Set<string>();
    sim.onEvent = () => {
      for (const robot of sim.robots) {
        if (robot.nextJobId === null) continue;
        chainedSeen++;
        if (!['loading', 'to_dropoff', 'unloading'].includes(robot.phase)) {
          badPhases.add(robot.phase);
        }
      }
    };
    sim.run();
    expect(chainedSeen).toBeGreaterThan(0);
    expect([...badPhases]).toEqual([]);
  });

  it('drives less empty distance than the plain queue under load', () => {
    let chain = 0;
    let fifo = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const scenario = buildScenario({ seed, horizon: 7200, jobsPerHour: 130 });
      chain += computeMetrics(new Simulation(scenario, createPolicy('chain')).run()).deadheadShare;
      fifo += computeMetrics(new Simulation(scenario, createPolicy('fifo')).run()).deadheadShare;
    }
    expect(chain).toBeLessThan(fifo);
  });
});

describe('batch assignment', () => {
  it('acts only on its ticks', () => {
    const spec: CustomScenario = {
      ...open,
      robots: [{ at: [4, 4] }],
      jobs: [{ pickup: [4, 4], dropoff: [4, 5], release: 3 }],
    };
    expect(run(spec, batchPolicy({ interval: 10 })).jobs[0]!.pickedAt).toBe(10);
    expect(run(spec, batchPolicy({ interval: 4 })).jobs[0]!.pickedAt).toBe(4);
    expect(run(spec, createPolicy('nearest')).jobs[0]!.pickedAt).toBe(3);
  });

  it('finds the assignment with the least total travel where greedy does not', () => {
    // Robot 0 is 1 from job 0 and 4 from job 1; robot 1 is 4 from job 0 and 9 from job 1.
    const spec: CustomScenario = {
      ...open,
      robots: [{ at: [5, 5] }, { at: [5, 0] }],
      jobs: [
        { pickup: [5, 4], dropoff: [0, 4], release: 0 },
        { pickup: [9, 5], dropoff: [9, 9], release: 0 },
      ],
      config: patient,
    };
    const greedy = run(spec, createPolicy('nearest'));
    expect(greedy.jobs.map((j) => j.robotId)).toEqual([0, 1]);
    const batch = run(spec, batchPolicy({ interval: 1 }));
    expect(batch.jobs.map((j) => j.robotId)).toEqual([1, 0]);
    const approach = (sim: Simulation): number =>
      sim.jobs.reduce((sum, j) => sum + (j.pickedAt! - j.release), 0);
    expect(approach(batch)).toBeLessThan(approach(greedy));
  });

  it('re-routes a robot when a better match appears', () => {
    const spec: CustomScenario = {
      ...open,
      robots: [{ at: [0, 0] }, { at: [9, 9] }],
      jobs: [
        // Keeps robot 1 busy: it will drop off two cells from job 1's pickup.
        { pickup: [9, 9], dropoff: [9, 2], release: 0 },
        // At the tick at t=10 robot 0 is the quicker one to reach this, and sets off.
        { pickup: [9, 0], dropoff: [8, 0], release: 6 },
        // Then this appears right beside robot 0. The best plan is now for robot 0
        // to take it and for robot 1 to chain job 1 after its delivery.
        { pickup: [2, 1], dropoff: [2, 5], release: 12 },
      ],
      config: patient,
    };
    const sim = new Simulation(customScenario(spec), batchPolicy({ interval: 5 }));
    const holders: (number | null)[] = [];
    sim.onEvent = () => {
      const job = sim.jobs[1]!;
      if (job.status === 'assigned' && holders.at(-1) !== job.robotId) holders.push(job.robotId);
    };
    sim.run();
    expect(holders).toEqual([0, 1]);
    expect(sim.jobs.map((j) => [j.status, j.robotId])).toEqual([
      ['delivered', 1],
      ['delivered', 1],
      ['delivered', 0],
    ]);
  });

  it('with an age credit, an old job outranks a nearer new one', () => {
    const spec: CustomScenario = {
      ...open,
      robots: [{ at: [0, 0] }],
      jobs: [
        { pickup: [0, 1], dropoff: [0, 3], release: 0 },
        { pickup: [9, 9], dropoff: [9, 8], release: 1 },
        { pickup: [0, 4], dropoff: [1, 4], release: 40 },
      ],
      config: patient,
    };
    const plain = run(spec, batchPolicy({ interval: 5, ageWeight: 0 }));
    expect(plain.jobs[2]!.pickedAt!).toBeLessThan(plain.jobs[1]!.pickedAt!);
    const aged = run(spec, batchPolicy({ interval: 5, ageWeight: 5 }));
    expect(aged.jobs[1]!.pickedAt!).toBeLessThan(aged.jobs[2]!.pickedAt!);
  });
});

describe('all policies', () => {
  it.each(POLICY_NAMES)('%s: never leaves a servable job waiting beside an idle robot', (name) => {
    const scenario = buildScenario({ seed: 9, horizon: 3600, jobsPerHour: 30 });
    const policy = createPolicy(name);
    const sim = new Simulation(scenario, policy);
    const interval = policy.tickInterval ?? 0;
    const idleSince = new Map<number, number>();
    let longestIdle = 0;
    sim.onEvent = () => {
      const waiting = sim.jobs.filter((j) => j.status === 'pending');
      for (const robot of sim.robots) {
        if (robot.phase !== 'idle' || waiting.length === 0) {
          idleSince.delete(robot.id);
          continue;
        }
        const since = idleSince.get(robot.id) ?? sim.now;
        idleSince.set(robot.id, since);
        // An event-driven policy reacts at once; the batch policy within one tick.
        longestIdle = Math.max(longestIdle, sim.now - since);
      }
    };
    sim.run();
    expect(longestIdle).toBeLessThanOrEqual(interval);
    expect(sim.jobs.filter((j) => j.status === 'delivered').length).toBe(scenario.jobs.length);
  });

  it.each(POLICY_NAMES)('%s: serves a quiet day completely and on time', (name) => {
    const scenario = buildScenario({ seed: 14, horizon: 3600, jobsPerHour: 20 });
    const metrics = computeMetrics(new Simulation(scenario, createPolicy(name)).run());
    expect(metrics.dropped).toBe(0);
    expect(metrics.delivered).toBe(scenario.jobs.length);
    expect(metrics.onTimeRate).toBeGreaterThan(0.9);
  });
});
