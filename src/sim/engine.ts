import type { Availability, DispatchContext, DispatchPolicy } from '../policies/types.ts';
import { EventQueue } from './event-queue.ts';
import type { Cell, RoadMap } from './road-map.ts';
import type { Scenario, SimConfig } from './scenario.ts';
import type { JobState, RobotState, Station } from './state.ts';

export type SimEvent =
  | { kind: 'release'; jobId: number }
  | { kind: 'expire'; jobId: number }
  | { kind: 'arrive'; robotId: number }
  | { kind: 'service'; robotId: number }
  | { kind: 'charged'; robotId: number }
  | { kind: 'tick' };

/**
 * Discrete-event simulation of one scenario under one dispatch policy.
 *
 * Robots move one road segment per event, so a robot is always either at a
 * cell or on a single segment, and plans can change at any cell boundary. The
 * engine owns the charging rule and the job lifecycle; the policy only decides
 * which robot takes which job.
 */
export class Simulation {
  readonly config: SimConfig;
  readonly map: RoadMap;
  readonly policy: DispatchPolicy;
  readonly robots: RobotState[];
  readonly jobs: JobState[];
  readonly stations: Station[];
  now = 0;
  eventsProcessed = 0;
  /** Called after each event has been fully handled. For tests and tracing. */
  onEvent: ((event: SimEvent) => void) | null = null;

  private readonly queue = new EventQueue<SimEvent>();
  /** Released jobs that are neither delivered nor dropped, in id order. */
  private active: JobState[] = [];
  private unresolved: number;
  private dirty = false;
  private trigger: 'event' | 'tick' = 'event';
  /** Distance from each cell to its nearest charger. */
  private readonly chargerDistance: Int32Array;
  private readonly context: DispatchContext;

  constructor(scenario: Scenario, policy: DispatchPolicy) {
    this.config = scenario.config;
    this.map = scenario.map;
    this.policy = policy;
    if (scenario.chargers.length === 0) throw new Error('a scenario needs at least one charger');

    this.stations = scenario.chargers.map((cell, id) => ({
      id,
      cell,
      bays: this.config.chargerBays,
      charging: [],
      waiting: [],
    }));
    this.chargerDistance = new Int32Array(this.map.blocked.length).fill(-1);
    for (const cell of this.map.freeCells) {
      let best = Infinity;
      for (const station of this.stations) {
        best = Math.min(best, this.map.distance(cell, station.cell));
      }
      if (best !== Infinity) this.chargerDistance[cell] = best;
    }

    this.robots = scenario.robots.map((start, id) => ({
      id,
      cell: start.cell,
      moving: null,
      target: null,
      phase: 'idle',
      jobId: null,
      nextJobId: null,
      battery: start.battery,
      stationId: null,
      phaseEndsAt: 0,
      chargeStartedAt: 0,
      distanceLoaded: 0,
      distanceEmpty: 0,
      busyTime: 0,
      busySince: null,
    }));
    this.jobs = scenario.jobs.map((job) => ({
      ...job,
      status: 'future',
      robotId: null,
      pickedAt: null,
      deliveredAt: null,
      droppedAt: null,
    }));
    this.unresolved = this.jobs.length;
    for (const job of this.jobs) {
      this.queue.push(job.release, { kind: 'release', jobId: job.id });
      this.queue.push(job.release + this.config.patience, { kind: 'expire', jobId: job.id });
    }
    if (policy.tickInterval !== undefined) {
      if (!(policy.tickInterval > 0)) throw new Error('tickInterval must be positive');
      this.queue.push(policy.tickInterval, { kind: 'tick' });
    }
    this.context = this.createContext();
  }

  /** True once every job has been delivered or dropped. */
  get done(): boolean {
    return this.unresolved === 0;
  }

  /** Handle the next event. Returns false when the run is over. */
  step(): boolean {
    if (this.done) return false;
    const next = this.queue.pop();
    if (next === undefined) throw new Error('event queue ran dry with jobs unresolved');
    this.now = next.time;
    this.eventsProcessed++;
    const event = next.value;
    this.dirty = false;
    switch (event.kind) {
      case 'release':
        this.onRelease(this.jobs[event.jobId]!);
        break;
      case 'expire':
        this.onExpire(this.jobs[event.jobId]!);
        break;
      case 'arrive':
        this.onArrive(this.robots[event.robotId]!);
        break;
      case 'service':
        this.onServiceDone(this.robots[event.robotId]!);
        break;
      case 'charged':
        this.onCharged(this.robots[event.robotId]!);
        break;
      case 'tick':
        this.queue.push(this.now + this.policy.tickInterval!, { kind: 'tick' });
        break;
    }
    if (event.kind === 'tick') this.dispatch('tick');
    else if (this.needsDispatch()) this.dispatch('event');
    this.onEvent?.(event);
    return !this.done;
  }

  /** Handle every event up to and including time `t`, then move the clock to `t`. */
  runUntil(t: number): void {
    while (!this.done && this.queue.peekTime() <= t) this.step();
    if (!this.done && t > this.now) this.now = t;
  }

  /** Run until every job is delivered or dropped. */
  run(): this {
    while (this.step()) {
      // step() does the work
    }
    return this;
  }

  /** Remaining range of a robot at the current time, including charge gained so far. */
  batteryOf(robot: Readonly<RobotState>): number {
    if (robot.phase !== 'charging') return robot.battery;
    const gained = (this.now - robot.chargeStartedAt) * this.config.chargeRate;
    return Math.min(this.config.batteryRange, robot.battery + gained);
  }

  /** The cell a robot is at, or will be at when it finishes its current segment. */
  positionOf(robot: Readonly<RobotState>): Cell {
    return robot.moving?.to ?? robot.cell;
  }

  // ---- events ---------------------------------------------------------------

  private onRelease(job: JobState): void {
    job.status = 'pending';
    this.active.push(job);
    this.dirty = true;
  }

  private onExpire(job: JobState): void {
    if (job.status !== 'pending' && job.status !== 'assigned') return;
    if (job.status === 'assigned') this.detach(job);
    job.status = 'dropped';
    job.droppedAt = this.now;
    this.resolve(job);
    this.dirty = true;
  }

  private onArrive(robot: RobotState): void {
    const edge = robot.moving;
    if (edge === null) throw new Error(`robot ${robot.id} arrived without moving`);
    robot.cell = edge.to;
    robot.moving = null;
    robot.battery -= 1;
    if (robot.battery < 0) throw new Error(`robot ${robot.id} ran out of battery`);
    if (robot.phase === 'to_dropoff') robot.distanceLoaded += 1;
    else robot.distanceEmpty += 1;
    if (robot.target === null) return;
    if (robot.cell === robot.target) this.onDestination(robot);
    else this.startEdge(robot);
  }

  private onDestination(robot: RobotState): void {
    robot.target = null;
    switch (robot.phase) {
      case 'to_pickup': {
        const job = this.jobs[robot.jobId!]!;
        job.status = 'carried';
        job.pickedAt = this.now;
        robot.phase = 'loading';
        robot.phaseEndsAt = this.now + this.config.loadTime;
        this.queue.push(robot.phaseEndsAt, { kind: 'service', robotId: robot.id });
        break;
      }
      case 'to_dropoff':
        robot.phase = 'unloading';
        robot.phaseEndsAt = this.now + this.config.unloadTime;
        this.queue.push(robot.phaseEndsAt, { kind: 'service', robotId: robot.id });
        break;
      case 'to_charger': {
        const station = this.stations[robot.stationId!]!;
        if (station.charging.length < station.bays) this.startCharging(robot, station);
        else {
          robot.phase = 'queued';
          station.waiting.push(robot.id);
        }
        break;
      }
      default:
        throw new Error(`robot ${robot.id} reached a destination while ${robot.phase}`);
    }
  }

  private onServiceDone(robot: RobotState): void {
    const job = this.jobs[robot.jobId!]!;
    if (robot.phase === 'loading') {
      robot.phase = 'to_dropoff';
      this.goTo(robot, job.dropoff);
      return;
    }
    if (robot.phase !== 'unloading') throw new Error(`robot ${robot.id} is not at a stop`);
    job.status = 'delivered';
    job.deliveredAt = this.now;
    this.resolve(job);
    this.closeBusy(robot);
    robot.jobId = null;
    robot.phase = 'idle';
    this.dirty = true;
    if (robot.nextJobId !== null) this.startNextJob(robot);
    else if (this.isLow(robot)) this.sendToCharger(robot);
  }

  private onCharged(robot: RobotState): void {
    const station = this.stations[robot.stationId!]!;
    robot.battery = this.config.batteryRange;
    robot.phase = 'idle';
    robot.stationId = null;
    station.charging = station.charging.filter((id) => id !== robot.id);
    const waiting = station.waiting.shift();
    if (waiting !== undefined) this.startCharging(this.robots[waiting]!, station);
    this.dirty = true;
  }

  // ---- movement -------------------------------------------------------------

  private goTo(robot: RobotState, target: Cell): void {
    robot.target = target;
    // A robot on a segment finishes it first; onArrive then carries on.
    if (robot.moving !== null) return;
    if (robot.cell === target) this.onDestination(robot);
    else this.startEdge(robot);
  }

  private startEdge(robot: RobotState): void {
    const to = this.map.nextStep(robot.cell, robot.target!);
    robot.moving = {
      from: robot.cell,
      to,
      departAt: this.now,
      arriveAt: this.now + 1 / this.config.speed,
    };
    this.queue.push(robot.moving.arriveAt, { kind: 'arrive', robotId: robot.id });
  }

  // ---- jobs -----------------------------------------------------------------

  private resolve(job: JobState): void {
    this.unresolved--;
    this.active = this.active.filter((j) => j !== job);
  }

  private startNextJob(robot: RobotState): void {
    const job = this.jobs[robot.nextJobId!]!;
    robot.nextJobId = null;
    this.startJob(robot, job);
  }

  private startJob(robot: RobotState, job: JobState): void {
    robot.jobId = job.id;
    robot.phase = 'to_pickup';
    robot.busySince = this.now;
    this.goTo(robot, job.pickup);
  }

  private closeBusy(robot: RobotState): void {
    if (robot.busySince !== null) robot.busyTime += this.now - robot.busySince;
    robot.busySince = null;
  }

  /** Release a robot from a job it has not picked up. */
  private detach(job: JobState): void {
    const robot = this.robots[job.robotId!]!;
    job.robotId = null;
    if (robot.nextJobId === job.id) {
      robot.nextJobId = null;
      return;
    }
    this.closeBusy(robot);
    robot.jobId = null;
    robot.target = null;
    robot.phase = 'idle';
    if (robot.nextJobId !== null) this.startNextJob(robot);
  }

  // ---- charging rule (shared by all policies) ------------------------------------

  /** Range needed to do a job from `from` and then reach a charger with the reserve. */
  private rangeNeeded(from: Cell, job: Readonly<JobState>): number {
    return (
      this.map.distance(from, job.pickup) +
      this.map.distance(job.pickup, job.dropoff) +
      this.chargerDistance[job.dropoff]! +
      this.config.reserve
    );
  }

  private isLow(robot: RobotState): boolean {
    return robot.battery < this.config.lowBattery * this.config.batteryRange;
  }

  private sendToCharger(robot: RobotState): void {
    const from = this.positionOf(robot);
    let best = this.stations[0]!;
    let bestDistance = Infinity;
    for (const station of this.stations) {
      const d = this.map.distance(from, station.cell);
      if (d < bestDistance) {
        bestDistance = d;
        best = station;
      }
    }
    robot.stationId = best.id;
    robot.phase = 'to_charger';
    this.goTo(robot, best.cell);
  }

  private startCharging(robot: RobotState, station: Station): void {
    station.charging.push(robot.id);
    robot.phase = 'charging';
    robot.chargeStartedAt = this.now;
    const missing = this.config.batteryRange - robot.battery;
    robot.phaseEndsAt = this.now + missing / this.config.chargeRate;
    this.queue.push(robot.phaseEndsAt, { kind: 'charged', robotId: robot.id });
  }

  /**
   * After the policy has had its say, send idle robots to charge if they are
   * low, or if a waiting job is out of their range now but would not be on a
   * full battery.
   */
  private chargingSweep(): void {
    const pending = this.active.filter((job) => job.status === 'pending');
    for (const robot of this.robots) {
      if (robot.phase !== 'idle') continue;
      const from = this.positionOf(robot);
      const battery = robot.battery - (robot.moving !== null ? 1 : 0);
      const blocked = pending.some((job) => {
        const need = this.rangeNeeded(from, job);
        return need > battery && need <= this.config.batteryRange;
      });
      if (blocked || this.isLow(robot)) this.sendToCharger(robot);
    }
  }

  // ---- dispatch -------------------------------------------------------------

  /** Whether the event just handled changed what a policy could act on. */
  private needsDispatch(): boolean {
    return this.dirty;
  }

  private dispatch(trigger: 'event' | 'tick'): void {
    this.trigger = trigger;
    this.policy.dispatch(this.context);
    this.chargingSweep();
  }

  private availability(robot: Readonly<RobotState>): Availability | null {
    if (robot.nextJobId !== null) return null;
    const { speed, loadTime, unloadTime } = this.config;
    const cell = this.positionOf(robot);
    const battery = robot.battery - (robot.moving !== null ? 1 : 0);
    const atCell = robot.moving?.arriveAt ?? this.now;
    if (robot.phase === 'idle') return { cell, time: atCell, battery };
    if (robot.jobId === null) return null;
    const job = this.jobs[robot.jobId]!;
    const carry = this.map.distance(job.pickup, job.dropoff);
    switch (robot.phase) {
      case 'to_pickup': {
        const approach = this.map.distance(cell, job.pickup);
        return {
          cell: job.dropoff,
          time: atCell + (approach + carry) / speed + loadTime + unloadTime,
          battery: battery - approach - carry,
        };
      }
      case 'loading':
        return {
          cell: job.dropoff,
          time: robot.phaseEndsAt + carry / speed + unloadTime,
          battery: battery - carry,
        };
      case 'to_dropoff': {
        const left = this.map.distance(cell, job.dropoff);
        return {
          cell: job.dropoff,
          time: atCell + left / speed + unloadTime,
          battery: battery - left,
        };
      }
      case 'unloading':
        return { cell: job.dropoff, time: robot.phaseEndsAt, battery };
      default:
        return null;
    }
  }

  private canAssign(robot: Readonly<RobotState>, job: Readonly<JobState>): boolean {
    if (job.status !== 'pending') return false;
    const free = this.availability(robot);
    if (free === null) return false;
    return this.rangeNeeded(free.cell, job) <= free.battery;
  }

  private assign(robotId: number, jobId: number): void {
    const robot = this.robots[robotId];
    const job = this.jobs[jobId];
    if (robot === undefined || job === undefined) throw new Error('unknown robot or job');
    if (!this.canAssign(robot, job)) {
      throw new Error(`robot ${robotId} cannot take job ${jobId}`);
    }
    job.status = 'assigned';
    job.robotId = robot.id;
    if (robot.phase === 'idle') this.startJob(robot, job);
    else robot.nextJobId = job.id;
  }

  private unassign(jobId: number): void {
    const job = this.jobs[jobId];
    if (job === undefined || job.status !== 'assigned') {
      throw new Error(`job ${jobId} is not assigned and waiting for pickup`);
    }
    this.detach(job);
    job.status = 'pending';
  }

  private createContext(): DispatchContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the context is a thin view of the engine
    const sim = this;
    return {
      get now() {
        return sim.now;
      },
      get trigger() {
        return sim.trigger;
      },
      speed: sim.config.speed,
      robots: sim.robots,
      pending: () => sim.active.filter((job) => job.status === 'pending'),
      assigned: () => sim.active.filter((job) => job.status === 'assigned'),
      distance: (from, to) => sim.map.distance(from, to),
      availability: (robot) => sim.availability(robot),
      canAssign: (robot, job) => sim.canAssign(robot, job),
      assign: (robotId, jobId) => {
        sim.assign(robotId, jobId);
      },
      unassign: (jobId) => {
        sim.unassign(jobId);
      },
    };
  }
}
