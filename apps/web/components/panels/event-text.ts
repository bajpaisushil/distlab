import type { SimEvent } from '@distlab/shared';
import { describe } from '@distlab/telemetry';

/** One line for an event, from the same describer the engine's log uses. */
export function describeEvent(event: SimEvent): string {
  return describe(event);
}

const CRITICAL = new Set(['REQUEST_FAILED', 'NODE_FAILED', 'PARTITION_STARTED', 'SAFETY_VIOLATION', 'VERSION_REGRESSION']);
const SERIOUS = new Set(['NODE_PAUSED', 'MESSAGE_DROPPED', 'REQUEST_REJECTED', 'TIMEOUT', 'CIRCUIT_OPENED', 'STALE_READ', 'LOCK_EXPIRED', 'FENCED_WRITE_REJECTED', 'QUEUE_DEAD_LETTERED', 'DUPLICATE_WRITE_APPLIED']);
const WARNING = new Set(['FAULT_INJECTED', 'MESSAGE_DUPLICATED', 'RETRY', 'LINK_STATE_CHANGED', 'LINK_CONFIG_CHANGED', 'NODE_CONDITION_CHANGED', 'ELECTION_STARTED', 'QUEUE_REDELIVERED', 'CACHE_MISS']);
const GOOD = new Set(['REQUEST_COMPLETED', 'NODE_RECOVERED', 'PARTITION_HEALED', 'LEADER_ELECTED', 'CIRCUIT_CLOSED', 'LOCK_ACQUIRED', 'NODE_RESUMED', 'QUEUE_CONSUMED']);

export function eventTone(type: string): 'good' | 'warning' | 'serious' | 'critical' | 'neutral' {
  if (CRITICAL.has(type)) return 'critical';
  if (SERIOUS.has(type)) return 'serious';
  if (WARNING.has(type)) return 'warning';
  if (GOOD.has(type)) return 'good';
  return 'neutral';
}
