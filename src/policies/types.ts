import type { Cell } from '../sim/road-map.ts';
import type { JobState, RobotState } from '../sim/state.ts';

/** When, where and with how much charge a robot will be free for another job. */
export interface Availability {
  cell: Cell;
  time: number;
  battery: number;
}

/**
 * What a policy sees and can do. The engine owns all state; a policy only
 * reads it and issues assign / unassign commands.
 */
export interface DispatchContext {
  readonly now: number;
  /** 'tick' for a policy's own periodic call, 'event' when something changed. */
  readonly trigger: 'event' | 'tick';
  /** Robot speed in cells per second. */
  readonly speed: number;
  readonly robots: readonly Readonly<RobotState>[];
  /** Released jobs waiting for a robot, oldest first. A fresh array on every call. */
  pending(): Readonly<JobState>[];
  /** Jobs committed to a robot but not picked up yet, oldest first. */
  assigned(): Readonly<JobState>[];
  /** Shortest road distance in cells. */
  distance(from: Cell, to: Cell): number;
  /**
   * Where and when the robot can start another job: now and here if it is
   * idle, at its drop-off once its current job is done if it is on one. Null
   * if it already has a next job, or is charging or on its way to charge.
   */
  availability(robot: Readonly<RobotState>): Availability | null;
  /**
   * Whether the robot may take the job. Applies the shared charging rule: after
   * the job the robot must still reach a charger with the reserve to spare.
   */
  canAssign(robot: Readonly<RobotState>, job: Readonly<JobState>): boolean;
  /**
   * Give a pending job to a robot. An idle robot sets off at once; a robot on
   * a job takes it as its next job. Throws if `canAssign` is false.
   */
  assign(robotId: number, jobId: number): void;
  /** Take back a job that has not been picked up; it becomes pending again. */
  unassign(jobId: number): void;
}

export interface DispatchPolicy {
  readonly name: string;
  /** If set, the engine also calls the policy every this many seconds. */
  readonly tickInterval?: number;
  /** Called after any event that changed what is available, and on ticks. */
  dispatch(ctx: DispatchContext): void;
}
