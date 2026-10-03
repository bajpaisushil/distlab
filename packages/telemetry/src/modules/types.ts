import type { EventType, SimEvent, SimTime } from '@distlab/shared';
import type { LogLevel } from '../logs.js';
import type { MetricsRegistry } from '../metrics.js';

/**
 * A subsystem's contribution to observability: how its events are logged,
 * which metrics they move, and the section it adds to the telemetry snapshot.
 *
 * Every number a module reports must be derived from events it recorded —
 * there is deliberately no access to engine state here, so nothing can be
 * reported that the simulation did not actually do.
 */
export interface TelemetryModule<S> {
  readonly name: string;
  readonly levels: Partial<Record<EventType, LogLevel>>;
  /** One log line for an event this module owns, or undefined to pass. */
  describe(event: SimEvent): string | undefined;
  record(event: SimEvent, metrics: MetricsRegistry): void;
  snapshot(metrics: MetricsRegistry, elapsedMs: SimTime): S;
}
