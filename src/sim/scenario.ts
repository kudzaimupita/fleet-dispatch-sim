import { generateJobs, type DemandPattern, type Job } from './demand.ts';
import { deriveSeed, Rng } from './rng.ts';
import { generateCity, RoadMap, spreadSites, type Cell } from './road-map.ts';

/**
 * Units: distance is in cells (one road segment), time in seconds, and battery
 * charge in cells of remaining range.
 */
export interface SimConfig {
  seed: number;
  robots: number;
  pattern: DemandPattern;
  /** Jobs are released during [0, horizon); the run then drains. Seconds. */
  horizon: number;
  jobsPerHour: number;
  width: number;
  height: number;
  chargers: number;
  /** Robots that can charge at one station at the same time. */
  chargerBays: number;
  /** Cells per second. */
  speed: number;
  /** Range on a full battery, in cells. */
  batteryRange: number;
  /** Cells of range gained per second on a charger. */
  chargeRate: number;
  /** An idle robot below this share of a full battery goes to charge. */
  lowBattery: number;
  /** Range a robot must have left on reaching a charger after a job, in cells. */
  reserve: number;
  loadTime: number;
  unloadTime: number;
  /** A job not picked up within this many seconds of release is dropped. */
  patience: number;
  deadlineSlack: number;
  deadlineFactor: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 1,
  robots: 6,
  pattern: 'uniform',
  horizon: 4 * 3600,
  jobsPerHour: 100,
  width: 28,
  height: 19,
  chargers: 3,
  chargerBays: 2,
  speed: 0.25,
  batteryRange: 600,
  chargeRate: 1.5,
  lowBattery: 0.25,
  reserve: 5,
  loadTime: 15,
  unloadTime: 15,
  patience: 600,
  deadlineSlack: 180,
  deadlineFactor: 2,
};

export interface RobotStart {
  cell: Cell;
  battery: number;
}

/** Everything a run needs that does not depend on the dispatch policy. */
export interface Scenario {
  readonly config: SimConfig;
  readonly map: RoadMap;
  readonly chargers: readonly Cell[];
  readonly robots: readonly RobotStart[];
  readonly jobs: readonly Job[];
}

/**
 * Build a scenario from a seed. The map, the fleet and the demand use separate
 * random streams, and no policy draws random numbers, so every policy run on
 * the same config faces exactly the same city and the same jobs.
 */
export function buildScenario(overrides: Partial<SimConfig> = {}): Scenario {
  const config: SimConfig = { ...DEFAULT_CONFIG, ...overrides };
  validate(config);
  const map = generateCity(new Rng(deriveSeed(config.seed, 'map')), {
    width: config.width,
    height: config.height,
  });
  const chargers = spreadSites(map, config.chargers);
  const fleetRng = new Rng(deriveSeed(config.seed, 'fleet'));
  const robots: RobotStart[] = [];
  for (let i = 0; i < config.robots; i++) {
    robots.push({
      cell: fleetRng.pick(map.freeCells),
      // Staggered starting charge, so the fleet does not all go to charge at once.
      battery: Math.round(config.batteryRange * fleetRng.range(0.6, 1)),
    });
  }
  const jobs = generateJobs(new Rng(deriveSeed(config.seed, 'demand')), map, config);
  return { config, map, chargers, robots, jobs };
}

export interface CustomScenario {
  width: number;
  height: number;
  /** Blocked cells as [x, y] pairs. */
  blocked?: readonly (readonly [number, number])[];
  chargers: readonly (readonly [number, number])[];
  robots: readonly { at: readonly [number, number]; battery?: number }[];
  jobs: readonly {
    pickup: readonly [number, number];
    dropoff: readonly [number, number];
    release: number;
    deadline?: number;
  }[];
  config?: Partial<SimConfig>;
}

/** Build a hand-written scenario. Meant for tests and small experiments. */
export function customScenario(spec: CustomScenario): Scenario {
  const config: SimConfig = {
    ...DEFAULT_CONFIG,
    ...spec.config,
    width: spec.width,
    height: spec.height,
    robots: spec.robots.length,
    chargers: spec.chargers.length,
  };
  validate(config);
  const blocked = new Uint8Array(spec.width * spec.height);
  for (const [x, y] of spec.blocked ?? []) blocked[y * spec.width + x] = 1;
  const map = new RoadMap(spec.width, spec.height, blocked);
  const at = ([x, y]: readonly [number, number]): Cell => {
    const cell = map.cell(x, y);
    if (!map.isFree(cell)) throw new Error(`cell ${x},${y} is not a free cell`);
    return cell;
  };
  const jobs = [...spec.jobs]
    .sort((a, b) => a.release - b.release)
    .map((job, id): Job => {
      const pickup = at(job.pickup);
      const dropoff = at(job.dropoff);
      const direct = map.distance(pickup, dropoff) / config.speed;
      return {
        id,
        pickup,
        dropoff,
        release: job.release,
        deadline:
          job.deadline ?? job.release + config.deadlineSlack + config.deadlineFactor * direct,
      };
    });
  return {
    config,
    map,
    chargers: spec.chargers.map(at),
    robots: spec.robots.map((r) => ({ cell: at(r.at), battery: r.battery ?? config.batteryRange })),
    jobs,
  };
}

function validate(config: SimConfig): void {
  const positive: (keyof SimConfig)[] = [
    'robots',
    'horizon',
    'width',
    'height',
    'chargers',
    'chargerBays',
    'speed',
    'batteryRange',
    'chargeRate',
    'patience',
  ];
  for (const key of positive) {
    const value = config[key];
    if (typeof value !== 'number' || !(value > 0)) {
      throw new Error(`config.${key} must be a positive number`);
    }
  }
  if (config.jobsPerHour < 0) throw new Error('config.jobsPerHour must not be negative');
  if (config.lowBattery < 0 || config.lowBattery >= 1) {
    throw new Error('config.lowBattery must be in [0, 1)');
  }
}
