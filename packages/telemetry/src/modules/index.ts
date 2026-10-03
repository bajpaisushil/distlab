import { faultsTelemetry, type FaultsTelemetry } from './faults.js';
import { routingTelemetry, type RoutingTelemetry } from './routing.js';
import { dataTelemetry, type DataTelemetry } from './data.js';
import { reliabilityTelemetry, type ReliabilityTelemetry } from './reliability.js';
import { queueTelemetry, type QueueTelemetry } from './queue.js';
import { consensusTelemetry, type ConsensusTelemetry } from './consensus.js';
import { locksTelemetry, type LockTelemetry } from './locks.js';
import type { TelemetryModule } from './types.js';

export type { TelemetryModule } from './types.js';
export type {
  FaultsTelemetry,
  RoutingTelemetry,
  DataTelemetry,
  ReliabilityTelemetry,
  QueueTelemetry,
  ConsensusTelemetry,
  LockTelemetry,
};

/** Per-subsystem sections of the telemetry snapshot. */
export interface ModuleTelemetry {
  readonly faults: FaultsTelemetry;
  readonly routing: RoutingTelemetry;
  readonly data: DataTelemetry;
  readonly reliability: ReliabilityTelemetry;
  readonly queues: QueueTelemetry;
  readonly consensus: ConsensusTelemetry;
  readonly locks: LockTelemetry;
}

/** Fixed order: log descriptions are tried in this order. */
export const TELEMETRY_MODULES: readonly TelemetryModule<unknown>[] = [
  faultsTelemetry,
  routingTelemetry,
  dataTelemetry,
  reliabilityTelemetry,
  queueTelemetry,
  consensusTelemetry,
  locksTelemetry,
];

export function moduleSnapshots(
  metrics: Parameters<TelemetryModule<unknown>['snapshot']>[0],
  elapsedMs: number,
): ModuleTelemetry {
  return {
    faults: faultsTelemetry.snapshot(metrics, elapsedMs),
    routing: routingTelemetry.snapshot(metrics, elapsedMs),
    data: dataTelemetry.snapshot(metrics, elapsedMs),
    reliability: reliabilityTelemetry.snapshot(metrics, elapsedMs),
    queues: queueTelemetry.snapshot(metrics, elapsedMs),
    consensus: consensusTelemetry.snapshot(metrics, elapsedMs),
    locks: locksTelemetry.snapshot(metrics, elapsedMs),
  };
}
