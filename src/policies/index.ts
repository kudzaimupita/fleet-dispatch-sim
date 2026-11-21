import { batchPolicy, type BatchOptions } from './batch.ts';
import { chainPolicy } from './chain.ts';
import { fifoPolicy } from './fifo.ts';
import { nearestIdlePolicy } from './nearest.ts';
import type { DispatchPolicy } from './types.ts';

export const POLICY_NAMES = ['nearest', 'fifo', 'chain', 'batch'] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];

export const POLICY_LABELS: Record<PolicyName, string> = {
  nearest: 'Nearest idle robot',
  fifo: 'First-come queue',
  chain: 'Queue with chaining',
  batch: 'Batch assignment',
};

export function isPolicyName(value: string): value is PolicyName {
  return (POLICY_NAMES as readonly string[]).includes(value);
}

export function createPolicy(
  name: PolicyName,
  options: { batch?: BatchOptions } = {},
): DispatchPolicy {
  switch (name) {
    case 'nearest':
      return nearestIdlePolicy();
    case 'fifo':
      return fifoPolicy();
    case 'chain':
      return chainPolicy();
    case 'batch':
      return batchPolicy(options.batch);
  }
}

export { batchPolicy, chainPolicy, fifoPolicy, nearestIdlePolicy };
export { solveAssignment } from './hungarian.ts';
export type { BatchOptions } from './batch.ts';
export type { Availability, DispatchContext, DispatchPolicy } from './types.ts';
