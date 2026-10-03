import type { SimEvent } from '@distlab/shared';
import type { TelemetryModule } from './types.js';

export interface DataTelemetry {
  readonly reads: number;
  readonly writes: number;
}

const round = (value: number) => Math.round(value * 100) / 100;

export const dataTelemetry: TelemetryModule<DataTelemetry> = {
  name: 'data',
  levels: { DB_READ: 'debug', DB_WRITE: 'debug' },
  describe(event) {
    switch (event.type) {
      case 'DB_READ': {
        const p = (event as SimEvent<'DB_READ'>).payload;
        return `${p.nodeId} read for ${p.requestId} (${round(p.latency)}ms)`;
      }
      case 'DB_WRITE': {
        const p = (event as SimEvent<'DB_WRITE'>).payload;
        return `${p.nodeId} wrote for ${p.requestId} (${round(p.latency)}ms)`;
      }
      default:
        return undefined;
    }
  },
  record(event, metrics) {
    if (event.type === 'DB_READ') {
      const p = (event as SimEvent<'DB_READ'>).payload;
      metrics.counter('db.reads').add(1, p.nodeId);
      metrics.histogram(`db.${p.nodeId}.read`).record(p.latency);
    } else if (event.type === 'DB_WRITE') {
      const p = (event as SimEvent<'DB_WRITE'>).payload;
      metrics.counter('db.writes').add(1, p.nodeId);
      metrics.histogram(`db.${p.nodeId}.write`).record(p.latency);
    }
  },
  snapshot(metrics) {
    return {
      reads: metrics.counter('db.reads').total,
      writes: metrics.counter('db.writes').total,
    };
  },
};
