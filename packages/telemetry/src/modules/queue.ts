import type { SimEvent } from '@distlab/shared';
import { EMPTY_PERCENTILES, type Percentiles } from '../metrics.js';
import type { TelemetryModule } from './types.js';

export interface QueueStats {
  readonly queueId: string;
  readonly enqueued: number;
  readonly consumed: number;
  readonly rejected: number;
  readonly redelivered: number;
  readonly deadLettered: number;
  readonly duplicates: number;
  /** Items waiting to be delivered, over time. */
  readonly depth: readonly { readonly t: number; readonly value: number }[];
  /** How long items waited before delivery, averaged per window — consumer lag. */
  readonly waitMs: readonly { readonly t: number; readonly value: number }[];
  /** Enqueue to acknowledgement. */
  readonly latency: Percentiles;
  readonly consumedPerSecond: readonly { readonly t: number; readonly value: number }[];
  readonly byWorker: Record<string, number>;
}

export interface QueueTelemetry {
  readonly queues: readonly QueueStats[];
}

export const queueTelemetry: TelemetryModule<QueueTelemetry> = {
  name: 'queue',
  levels: {
    QUEUE_MESSAGE: 'debug',
    QUEUE_DELIVERED: 'debug',
    QUEUE_CONSUMED: 'debug',
    WORKER_PROCESSED: 'debug',
    QUEUE_REJECTED: 'warn',
    QUEUE_REDELIVERED: 'warn',
    QUEUE_DEAD_LETTERED: 'error',
    DUPLICATE_PROCESSING: 'warn',
  },
  describe(event) {
    switch (event.type) {
      case 'QUEUE_MESSAGE': {
        const p = (event as SimEvent<'QUEUE_MESSAGE'>).payload;
        return `${p.queueId} enqueued ${p.itemId}${p.poison ? ' (poison)' : ''}; ${p.depth} waiting`;
      }
      case 'QUEUE_REJECTED': {
        const p = (event as SimEvent<'QUEUE_REJECTED'>).payload;
        return `${p.queueId} is full (${p.held}/${p.capacity}) and refused ${p.requestId}`;
      }
      case 'QUEUE_DELIVERED': {
        const p = (event as SimEvent<'QUEUE_DELIVERED'>).payload;
        return `${p.queueId} delivered ${p.itemId} to ${p.workerId} (attempt ${p.attempt}, waited ${Math.round(p.waitedMs)}ms)`;
      }
      case 'QUEUE_CONSUMED': {
        const p = (event as SimEvent<'QUEUE_CONSUMED'>).payload;
        return `${p.workerId} finished ${p.itemId} ${Math.round(p.latencyMs)}ms after it was enqueued${p.attempts > 1 ? ` (${p.attempts} attempts)` : ''}`;
      }
      case 'QUEUE_REDELIVERED': {
        const p = (event as SimEvent<'QUEUE_REDELIVERED'>).payload;
        return `${p.queueId} will redeliver ${p.itemId}: ${p.reason === 'nack' ? `${p.workerId} failed it (${p.error})` : `no ack from ${p.workerId} in time`}`;
      }
      case 'QUEUE_DEAD_LETTERED': {
        const p = (event as SimEvent<'QUEUE_DEAD_LETTERED'>).payload;
        return `${p.queueId} dead-lettered ${p.itemId} after ${p.attempts} attempts${p.deadLetterQueue ? ` to ${p.deadLetterQueue}` : ''}: ${p.lastError}`;
      }
      case 'DUPLICATE_PROCESSING': {
        const p = (event as SimEvent<'DUPLICATE_PROCESSING'>).payload;
        return `${p.itemId} was processed again by ${p.workerId} — ${p.times} times in total`;
      }
      case 'WORKER_PROCESSED': {
        const p = (event as SimEvent<'WORKER_PROCESSED'>).payload;
        return `${p.workerId} ${p.outcome === 'ok' ? 'processed' : 'failed'} ${p.itemId} in ${Math.round(p.serviceTime)}ms`;
      }
      default:
        return undefined;
    }
  },
  record(event, metrics) {
    const q = (id: string) => {
      metrics.set('queue.queues').add(id);
      return id;
    };
    switch (event.type) {
      case 'QUEUE_MESSAGE': {
        const p = (event as SimEvent<'QUEUE_MESSAGE'>).payload;
        metrics.counter('queue.enqueued').add(1, q(p.queueId));
        metrics.timeline(`queue.depth.${p.queueId}`).record(event.at, p.depth);
        return;
      }
      case 'QUEUE_REJECTED':
        metrics.counter('queue.rejected').add(1, q((event as SimEvent<'QUEUE_REJECTED'>).payload.queueId));
        return;
      case 'QUEUE_DELIVERED': {
        const p = (event as SimEvent<'QUEUE_DELIVERED'>).payload;
        metrics.timeline(`queue.depth.${q(p.queueId)}`).record(event.at, p.depth);
        metrics.timeSeries(`queue.wait.${p.queueId}`).record(event.at, p.waitedMs);
        return;
      }
      case 'QUEUE_CONSUMED': {
        const p = (event as SimEvent<'QUEUE_CONSUMED'>).payload;
        metrics.counter('queue.consumed').add(1, q(p.queueId));
        metrics.counter(`queue.by_worker.${p.queueId}`).add(1, p.workerId);
        metrics.histogram(`queue.latency.${p.queueId}`).record(p.latencyMs);
        metrics.timeSeries(`queue.consumed.${p.queueId}`).record(event.at);
        metrics.timeline(`queue.depth.${p.queueId}`).record(event.at, p.depth);
        return;
      }
      case 'QUEUE_REDELIVERED':
        metrics.counter('queue.redelivered').add(1, q((event as SimEvent<'QUEUE_REDELIVERED'>).payload.queueId));
        return;
      case 'QUEUE_DEAD_LETTERED':
        metrics.counter('queue.dead').add(1, q((event as SimEvent<'QUEUE_DEAD_LETTERED'>).payload.queueId));
        return;
      case 'DUPLICATE_PROCESSING':
        metrics.counter('queue.duplicates').add(1, q((event as SimEvent<'DUPLICATE_PROCESSING'>).payload.queueId));
        return;
      default:
        return;
    }
  },
  snapshot(metrics) {
    const by = (name: string, id: string) => metrics.counter(name).byLabel()[id] ?? 0;
    return {
      queues: [...metrics.set('queue.queues').values()].sort().map((queueId) => ({
        queueId,
        enqueued: by('queue.enqueued', queueId),
        consumed: by('queue.consumed', queueId),
        rejected: by('queue.rejected', queueId),
        redelivered: by('queue.redelivered', queueId),
        deadLettered: by('queue.dead', queueId),
        duplicates: by('queue.duplicates', queueId),
        depth: metrics.timeline(`queue.depth.${queueId}`).points().map((p) => ({ t: p.t, value: Number(p.value) })),
        waitMs: metrics.timeSeries(`queue.wait.${queueId}`).meanPerWindow(),
        latency: metrics.hasHistogram(`queue.latency.${queueId}`)
          ? metrics.histogram(`queue.latency.${queueId}`).percentiles()
          : EMPTY_PERCENTILES,
        consumedPerSecond: metrics.timeSeries(`queue.consumed.${queueId}`).ratePerSecond(),
        byWorker: metrics.counter(`queue.by_worker.${queueId}`).byLabel(),
      })),
    };
  },
};
