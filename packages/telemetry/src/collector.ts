import type { NodeId, SimEvent, SimTime } from '@distlab/shared';
import { LogCollector, type LogLevel } from './logs.js';
import { EMPTY_PERCENTILES, MetricsRegistry, type Percentiles } from './metrics.js';
import { TraceCollector } from './traces.js';

/** Node state the engine owns; telemetry reads it rather than duplicating it. */
export interface NodeStateInput {
  readonly id: NodeId;
  readonly label: string;
  readonly status: string;
  readonly inFlight: number;
  readonly queueDepth: number;
  readonly processed: number;
  readonly failed: number;
  readonly rejected: number;
  readonly utilization: number;
}

export interface NodeTelemetry extends NodeStateInput {
  readonly maxQueueDepth: number;
  readonly serviceTime: Percentiles;
}

export interface TelemetrySnapshot {
  readonly elapsedMs: SimTime;
  readonly requests: {
    readonly created: number;
    readonly completed: number;
    readonly failed: number;
    readonly rejected: number;
    /** Completed as a fraction of settled requests; 0 when nothing settled. */
    readonly successRate: number;
    readonly throughputPerSec: number;
  };
  readonly latency: Percentiles;
  readonly failuresByReason: Record<string, number>;
  readonly messages: {
    readonly sent: number;
    readonly received: number;
    readonly dropped: number;
    readonly duplicated: number;
    readonly dropsByReason: Record<string, number>;
  };
  readonly timeouts: number;
  readonly database: { readonly reads: number; readonly writes: number };
  readonly nodes: readonly NodeTelemetry[];
  readonly throughput: {
    readonly completed: readonly { t: SimTime; value: number }[];
    readonly failed: readonly { t: SimTime; value: number }[];
  };
}

export interface TelemetryOptions {
  readonly logCapacity?: number;
  readonly logLevel?: LogLevel;
  readonly metricsWindowMs?: number;
  readonly traceCapacity?: number;
  /** Tracing is the most expensive collector; very large runs can turn it off. */
  readonly captureTraces?: boolean;
}

/**
 * Derives logs, metrics and traces from the event stream.
 *
 * It is a pure observer: it never schedules events and never touches node
 * state, so attaching or detaching it cannot change what the simulation does.
 * Every number it reports traces back to an event the engine actually
 * processed — there is nowhere for an invented metric to come from.
 */
export class TelemetryCollector {
  readonly logs: LogCollector;
  readonly metrics: MetricsRegistry;
  readonly traces: TraceCollector;

  private readonly captureTraces: boolean;

  constructor(options: TelemetryOptions = {}) {
    this.logs = new LogCollector(options.logCapacity ?? 20_000, options.logLevel ?? 'debug');
    this.metrics = new MetricsRegistry(options.metricsWindowMs ?? 1000);
    this.traces = new TraceCollector(options.traceCapacity ?? 5000);
    this.captureTraces = options.captureTraces ?? true;
  }

  observe(event: SimEvent): void {
    this.logs.record(event);
    if (this.captureTraces) this.traces.observe(event);
    this.recordMetrics(event);
  }

  snapshot(elapsedMs: SimTime, nodes: readonly NodeStateInput[]): TelemetrySnapshot {
    const created = this.metrics.counter('requests.created').total;
    const completed = this.metrics.counter('requests.completed').total;
    const failed = this.metrics.counter('requests.failed').total;
    const settled = completed + failed;
    const seconds = elapsedMs / 1000;

    return {
      elapsedMs,
      requests: {
        created,
        completed,
        failed,
        rejected: this.metrics.counter('requests.rejected').total,
        successRate: settled === 0 ? 0 : completed / settled,
        throughputPerSec: seconds === 0 ? 0 : completed / seconds,
      },
      latency: this.metrics.histogram('request.latency').percentiles(),
      failuresByReason: this.metrics.counter('requests.failed').byLabel(),
      messages: {
        sent: this.metrics.counter('messages.sent').total,
        received: this.metrics.counter('messages.received').total,
        dropped: this.metrics.counter('messages.dropped').total,
        duplicated: this.metrics.counter('messages.duplicated').total,
        dropsByReason: this.metrics.counter('messages.dropped').byLabel(),
      },
      timeouts: this.metrics.counter('timeouts').total,
      database: {
        reads: this.metrics.counter('db.reads').total,
        writes: this.metrics.counter('db.writes').total,
      },
      nodes: nodes.map((node) => ({
        ...node,
        maxQueueDepth: this.metrics.gauge(`node.${node.id}.queue_depth`).max,
        serviceTime: this.hasHistogram(`node.${node.id}.service_time`)
          ? this.metrics.histogram(`node.${node.id}.service_time`).percentiles()
          : EMPTY_PERCENTILES,
      })),
      throughput: {
        completed: this.metrics.timeSeries('requests.completed').ratePerSecond(),
        failed: this.metrics.timeSeries('requests.failed').ratePerSecond(),
      },
    };
  }

  private recordMetrics(event: SimEvent): void {
    switch (event.type) {
      case 'REQUEST_CREATED': {
        this.metrics.counter('requests.created').add();
        this.metrics.timeSeries('requests.created').record(event.at);
        return;
      }
      case 'REQUEST_COMPLETED': {
        const p = (event as SimEvent<'REQUEST_COMPLETED'>).payload;
        this.metrics.counter('requests.completed').add();
        this.metrics.histogram('request.latency').record(p.latency);
        this.metrics.histogram('request.hops').record(p.hops);
        this.metrics.timeSeries('requests.completed').record(event.at, p.latency);
        return;
      }
      case 'REQUEST_FAILED': {
        const p = (event as SimEvent<'REQUEST_FAILED'>).payload;
        this.metrics.counter('requests.failed').add(1, p.reason);
        this.metrics.timeSeries('requests.failed').record(event.at, p.latency);
        return;
      }
      case 'REQUEST_REJECTED': {
        const p = (event as SimEvent<'REQUEST_REJECTED'>).payload;
        this.metrics.counter('requests.rejected').add(1, p.nodeId);
        this.metrics.gauge(`node.${p.nodeId}.queue_depth`).set(p.queueDepth);
        return;
      }
      case 'REQUEST_QUEUED': {
        const p = (event as SimEvent<'REQUEST_QUEUED'>).payload;
        this.metrics.gauge(`node.${p.nodeId}.queue_depth`).set(p.queueDepth);
        this.metrics.timeSeries(`node.${p.nodeId}.queue_depth`).record(event.at, p.queueDepth);
        return;
      }
      case 'REQUEST_PROCESSING_COMPLETED': {
        const p = (event as SimEvent<'REQUEST_PROCESSING_COMPLETED'>).payload;
        this.metrics.histogram(`node.${p.nodeId}.service_time`).record(p.serviceTime);
        return;
      }
      case 'MESSAGE_SENT': {
        const p = (event as SimEvent<'MESSAGE_SENT'>).payload;
        this.metrics.counter('messages.sent').add();
        this.metrics.counter('messages.bytes').add(p.message.sizeBytes);
        return;
      }
      case 'MESSAGE_RECEIVED':
        this.metrics.counter('messages.received').add();
        return;
      case 'MESSAGE_DROPPED': {
        const p = (event as SimEvent<'MESSAGE_DROPPED'>).payload;
        this.metrics.counter('messages.dropped').add(1, p.reason);
        this.metrics.timeSeries('messages.dropped').record(event.at);
        return;
      }
      case 'MESSAGE_DUPLICATED':
        this.metrics.counter('messages.duplicated').add();
        return;
      case 'TIMEOUT': {
        const p = (event as SimEvent<'TIMEOUT'>).payload;
        this.metrics.counter('timeouts').add(1, p.nodeId);
        return;
      }
      case 'DB_READ': {
        const p = (event as SimEvent<'DB_READ'>).payload;
        this.metrics.counter('db.reads').add(1, p.nodeId);
        this.metrics.histogram(`db.${p.nodeId}.read`).record(p.latency);
        return;
      }
      case 'DB_WRITE': {
        const p = (event as SimEvent<'DB_WRITE'>).payload;
        this.metrics.counter('db.writes').add(1, p.nodeId);
        this.metrics.histogram(`db.${p.nodeId}.write`).record(p.latency);
        return;
      }
      case 'NODE_FAILED':
        this.metrics.counter('nodes.failed').add(1, (event as SimEvent<'NODE_FAILED'>).payload.nodeId);
        return;
      case 'NODE_RECOVERED':
        this.metrics.counter('nodes.recovered').add(1, (event as SimEvent<'NODE_RECOVERED'>).payload.nodeId);
        return;
      default:
        return;
    }
  }

  private hasHistogram(name: string): boolean {
    return this.metrics.histogramNames().includes(name);
  }
}
