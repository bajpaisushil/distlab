import type {
  EventType,
  LinkId,
  MessageKind,
  NodeId,
  PartitionSpec,
  ResponseStatus,
  SimEvent,
  SimulationSpec,
  SpecIssue,
} from '@distlab/shared';
import type { LogLevel, LogRecord, TelemetrySnapshot, Trace } from '@distlab/telemetry';
import type { NodeSnapshot, SimulationStatus } from '@distlab/simulation-engine';

/** A link as it stands right now, faults applied. */
export interface LinkState {
  readonly id: LinkId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly enabled: boolean;
  readonly bidirectional: boolean;
  readonly lossRate: number;
  readonly duplicateRate: number;
  readonly meanLatency: number;
}

/** A message on the wire, for drawing it moving along its link. */
export interface InFlightMessage {
  readonly id: string;
  readonly kind: MessageKind;
  readonly source: NodeId;
  readonly destination: NodeId;
  readonly sentAt: number;
  readonly deliverAt: number;
  readonly status?: ResponseStatus;
  readonly duplicate: boolean;
}

export type MarkerKind = 'fault' | 'failure' | 'recovery' | 'leader' | 'violation' | 'circuit' | 'partition';

/** A notable moment worth flagging on the replay timeline. */
export interface TimelineMarker {
  readonly position: number;
  readonly at: number;
  readonly kind: MarkerKind;
  readonly label: string;
  readonly eventId: string;
}

/** Everything the UI renders for one instant, batched rather than per event. */
export interface Frame {
  readonly seq: number;
  readonly specId: string;
  readonly position: number;
  readonly reachable: number;
  /** Virtual time of the furthest event computed so far. */
  readonly reachableTime: number;
  readonly now: number;
  readonly durationMs: number;
  readonly status: SimulationStatus;
  readonly playing: boolean;
  readonly speed: number;
  readonly snapshot: TelemetrySnapshot;
  readonly nodes: readonly NodeSnapshot[];
  readonly links: readonly LinkState[];
  readonly partitions: readonly PartitionSpec[];
  readonly inFlight: readonly InFlightMessage[];
  readonly inFlightTotal: number;
  /** The last events up to the current position, newest last. */
  readonly recent: readonly SimEvent[];
  readonly markers: readonly TimelineMarker[];
}

export interface EventFilter {
  readonly types?: readonly EventType[];
  readonly nodeId?: NodeId;
  readonly traceId?: string;
  readonly text?: string;
  /** Inclusive virtual-time window. */
  readonly fromTime?: number;
  readonly toTime?: number;
  /** Only events at or before the current position. Default true. */
  readonly upToCurrent?: boolean;
}

export interface LogFilter {
  readonly minLevel?: LogLevel;
  readonly nodeId?: NodeId;
  readonly text?: string;
}

export interface Page<T> {
  readonly total: number;
  readonly offset: number;
  readonly items: readonly T[];
}

export interface EventDetail {
  readonly event: SimEvent;
  readonly index: number;
  readonly description: string;
  /** Causal ancestors, root first, ending with the event itself. */
  readonly chain: readonly SimEvent[];
  /** Events this one directly caused. */
  readonly effects: readonly SimEvent[];
  /** Every node's state immediately before this event. */
  readonly nodesBefore: readonly NodeSnapshot[];
}

export interface RunSummary {
  readonly specId: string;
  readonly events: number;
  readonly endedAt: number;
  readonly wallMs: number;
  readonly snapshot: TelemetrySnapshot;
}

export type Query =
  | { readonly kind: 'events'; readonly filter: EventFilter; readonly offset: number; readonly limit: number }
  | { readonly kind: 'logs'; readonly filter: LogFilter; readonly offset: number; readonly limit: number }
  | { readonly kind: 'traces'; readonly sort: 'slowest' | 'recent' | 'failed'; readonly limit: number }
  | { readonly kind: 'trace'; readonly traceId: string }
  | { readonly kind: 'eventDetail'; readonly eventId: string }
  | { readonly kind: 'run'; readonly spec: SimulationSpec };

export interface QueryResults {
  events: Page<SimEvent>;
  logs: Page<LogRecord>;
  traces: readonly Trace[];
  trace: Trace | null;
  eventDetail: EventDetail | null;
  run: RunSummary;
}

export type WorkerRequest =
  | { readonly type: 'load'; readonly spec: SimulationSpec; readonly keepTime: boolean }
  | { readonly type: 'play'; readonly speed: number }
  | { readonly type: 'pause' }
  | { readonly type: 'setSpeed'; readonly speed: number }
  | { readonly type: 'step'; readonly count: number }
  | { readonly type: 'back'; readonly count: number }
  | { readonly type: 'seek'; readonly position: number }
  | { readonly type: 'seekTime'; readonly time: number }
  | { readonly type: 'toEnd' }
  | { readonly type: 'reset' }
  | { readonly type: 'query'; readonly id: number; readonly query: Query };

export type WorkerResponse =
  | { readonly type: 'frame'; readonly frame: Frame }
  | { readonly type: 'invalid'; readonly issues: readonly SpecIssue[] }
  | { readonly type: 'result'; readonly id: number; readonly result: unknown }
  | { readonly type: 'error'; readonly message: string; readonly id?: number };
