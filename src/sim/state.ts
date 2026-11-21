import type { Job } from './demand.ts';
import type { Cell } from './road-map.ts';

/**
 * future    not released yet
 * pending   released, waiting for a robot
 * assigned  a robot is committed to it but has not reached the pickup
 * carried   picked up (loading has started) and not yet delivered
 * delivered unloaded at the drop-off
 * dropped   not picked up within the patience window
 */
export type JobStatus = 'future' | 'pending' | 'assigned' | 'carried' | 'delivered' | 'dropped';

export interface JobState extends Job {
  status: JobStatus;
  robotId: number | null;
  pickedAt: number | null;
  deliveredAt: number | null;
  droppedAt: number | null;
}

export type RobotPhase =
  | 'idle'
  | 'to_pickup'
  | 'loading'
  | 'to_dropoff'
  | 'unloading'
  | 'to_charger'
  | 'queued'
  | 'charging';

export interface Edge {
  from: Cell;
  to: Cell;
  departAt: number;
  arriveAt: number;
}

export interface RobotState {
  readonly id: number;
  /** Last cell the robot reached. */
  cell: Cell;
  /** The road segment being driven, if any. A segment is never abandoned half way. */
  moving: Edge | null;
  /** Where the robot is heading, if anywhere. */
  target: Cell | null;
  phase: RobotPhase;
  /** The job being served (capacity is one parcel). */
  jobId: number | null;
  /** A job to start as soon as the current one is delivered. */
  nextJobId: number | null;
  /** Remaining range in cells. While charging this is the level at plug-in. */
  battery: number;
  /** Index of the station the robot is heading to, waiting at or charging at. */
  stationId: number | null;
  /** When the current loading, unloading or charging ends. */
  phaseEndsAt: number;
  chargeStartedAt: number;
  distanceLoaded: number;
  distanceEmpty: number;
  /** Seconds spent on jobs: driving to a pickup, loading, carrying, unloading. */
  busyTime: number;
  busySince: number | null;
}

export interface Station {
  readonly id: number;
  readonly cell: Cell;
  readonly bays: number;
  /** Robot ids on a bay. */
  charging: number[];
  /** Robot ids waiting for a bay, first come first served. */
  waiting: number[];
}
