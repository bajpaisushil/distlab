import type { EventId, EventType, NodeId, SimEvent, SimTime, TraceId } from '@distlab/shared';
import { TELEMETRY_MODULES } from './modules/index.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogRecord {
  readonly t: SimTime;
  readonly level: LogLevel;
  readonly message: string;
  readonly eventId: EventId;
  readonly eventType: EventType;
  readonly nodeId?: NodeId;
  readonly traceId?: TraceId;
}

/**
 * Severity per event type.
 *
 * Routine traffic is debug so a busy run does not bury the interesting lines;
 * anything that loses work is an error.
 */
const CORE_LEVELS: Partial<Record<EventType, LogLevel>> = {
  SIMULATION_STARTED: 'info',
  SIMULATION_COMPLETED: 'info',
  WORKLOAD_TICK: 'debug',
  TIMER: 'debug',
  REQUEST_CREATED: 'debug',
  REQUEST_ROUTED: 'debug',
  REQUEST_QUEUED: 'debug',
  REQUEST_PROCESSING_STARTED: 'debug',
  REQUEST_PROCESSING_COMPLETED: 'debug',
  REQUEST_COMPLETED: 'debug',
  MESSAGE_SENT: 'debug',
  MESSAGE_RECEIVED: 'debug',
  REQUEST_REJECTED: 'warn',
  MESSAGE_DUPLICATED: 'warn',
  MESSAGE_DROPPED: 'warn',
  TIMEOUT: 'warn',
  NODE_RECOVERED: 'warn',
  REQUEST_FAILED: 'error',
  NODE_FAILED: 'error',
};

/** Module levels layered over the core table; a module may only claim its own events. */
const EVENT_LEVELS: Partial<Record<EventType, LogLevel>> = Object.assign(
  {},
  CORE_LEVELS,
  ...TELEMETRY_MODULES.map((module) => module.levels),
);

export function levelOf(type: EventType): LogLevel {
  return EVENT_LEVELS[type] ?? 'info';
}

/** Structured log derived from the event stream, kept in a bounded ring. */
export class LogCollector {
  private records: LogRecord[] = [];

  constructor(
    private readonly capacity = 20_000,
    private readonly minLevel: LogLevel = 'debug',
  ) {}

  record(event: SimEvent): void {
    const level = levelOf(event.type);
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    this.records.push({
      t: event.at,
      level,
      message: describe(event),
      eventId: event.id,
      eventType: event.type,
      ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
      ...(event.traceId !== undefined ? { traceId: event.traceId } : {}),
    });
    if (this.records.length > this.capacity) this.records.shift();
  }

  all(): readonly LogRecord[] {
    return this.records;
  }

  atLeast(level: LogLevel): LogRecord[] {
    return this.records.filter((r) => LEVEL_ORDER[r.level] >= LEVEL_ORDER[level]);
  }

  forTrace(traceId: TraceId): LogRecord[] {
    return this.records.filter((r) => r.traceId === traceId);
  }

  clear(): void {
    this.records = [];
  }

  captureState(): readonly LogRecord[] {
    return [...this.records];
  }

  restoreState(state: readonly LogRecord[]): void {
    this.records = [...state];
  }
}

/**
 * One line describing an event.
 *
 * Every number here comes from the event payload. Nothing is inferred, which
 * is what lets the AI layer later quote a log line as a measured fact.
 */
export function describe(event: SimEvent): string {
  // Core and request events are described here; everything else belongs to a module.
  switch (event.type) {
    case 'SIMULATION_STARTED': {
      const p = (event as SimEvent<'SIMULATION_STARTED'>).payload;
      return `simulation started with seed "${p.seed}" (${p.nodeCount} nodes, ${p.linkCount} links)`;
    }
    case 'SIMULATION_COMPLETED': {
      const p = (event as SimEvent<'SIMULATION_COMPLETED'>).payload;
      return `simulation ended (${p.reason}) after ${p.eventsProcessed} events`;
    }
    case 'REQUEST_CREATED': {
      const p = (event as SimEvent<'REQUEST_CREATED'>).payload;
      return `${p.requestId} created at ${p.clientId} (${p.operation})`;
    }
    case 'REQUEST_ROUTED': {
      const p = (event as SimEvent<'REQUEST_ROUTED'>).payload;
      return `${p.requestId} routed ${p.from} -> ${p.to} (hop ${p.hop}, ${p.strategy})`;
    }
    case 'REQUEST_QUEUED': {
      const p = (event as SimEvent<'REQUEST_QUEUED'>).payload;
      return `${p.requestId} queued at ${p.nodeId} (depth ${p.queueDepth})`;
    }
    case 'REQUEST_REJECTED': {
      const p = (event as SimEvent<'REQUEST_REJECTED'>).payload;
      return `${p.nodeId} rejected ${p.requestId}: ${p.reason} (depth ${p.queueDepth})`;
    }
    case 'REQUEST_PROCESSING_STARTED': {
      const p = (event as SimEvent<'REQUEST_PROCESSING_STARTED'>).payload;
      return `${p.nodeId} started ${p.requestId} (service ${round(p.serviceTime)}ms)`;
    }
    case 'REQUEST_PROCESSING_COMPLETED': {
      const p = (event as SimEvent<'REQUEST_PROCESSING_COMPLETED'>).payload;
      return `${p.nodeId} finished ${p.requestId} (${p.outcome}, ${round(p.serviceTime)}ms)`;
    }
    case 'REQUEST_COMPLETED': {
      const p = (event as SimEvent<'REQUEST_COMPLETED'>).payload;
      return `${p.requestId} completed in ${round(p.latency)}ms via ${p.path.join(' -> ')}`;
    }
    case 'REQUEST_FAILED': {
      const p = (event as SimEvent<'REQUEST_FAILED'>).payload;
      const where = p.failedAt ? ` at ${p.failedAt}` : '';
      return `${p.requestId} failed after ${round(p.latency)}ms: ${p.reason}${where}`;
    }
    case 'MESSAGE_SENT': {
      const p = (event as SimEvent<'MESSAGE_SENT'>).payload;
      return `${p.message.source} -> ${p.message.destination}: ${p.message.kind} ${p.message.type} (${p.message.sizeBytes}B)`;
    }
    case 'MESSAGE_RECEIVED': {
      const p = (event as SimEvent<'MESSAGE_RECEIVED'>).payload;
      const dup = p.message.duplicateOf ? ' [duplicate]' : '';
      return `${p.message.destination} received ${p.message.kind} from ${p.message.source}${dup}`;
    }
    case 'MESSAGE_DROPPED': {
      const p = (event as SimEvent<'MESSAGE_DROPPED'>).payload;
      return `dropped message ${p.source} -> ${p.destination}: ${p.reason}`;
    }
    case 'MESSAGE_DUPLICATED': {
      const p = (event as SimEvent<'MESSAGE_DUPLICATED'>).payload;
      return `network duplicated ${p.originalId} as ${p.duplicateId} on ${p.linkId}`;
    }
    case 'TIMEOUT': {
      const p = (event as SimEvent<'TIMEOUT'>).payload;
      return `${p.nodeId} gave up on ${p.requestId} at deadline ${round(p.deadlineAt)}ms`;
    }
    case 'NODE_FAILED': {
      const p = (event as SimEvent<'NODE_FAILED'>).payload;
      return `${p.nodeId} failed: ${p.reason}`;
    }
    case 'NODE_RECOVERED':
      return `${(event as SimEvent<'NODE_RECOVERED'>).payload.nodeId} recovered`;
    case 'WORKLOAD_TICK': {
      const p = (event as SimEvent<'WORKLOAD_TICK'>).payload;
      return `workload ${p.workloadId} tick (${p.emitted} emitted)`;
    }
    case 'TIMER': {
      const p = (event as SimEvent<'TIMER'>).payload;
      return `${p.nodeId} ${p.module} timer "${p.name}" fired`;
    }
    default: {
      for (const module of TELEMETRY_MODULES) {
        const line = module.describe(event);
        if (line !== undefined) return line;
      }
      return event.type.toLowerCase().replace(/_/g, ' ');
    }
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
