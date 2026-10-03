import type { SimEvent } from '@distlab/shared';
import type { TelemetryModule } from './types.js';

export interface CircuitTelemetry {
  readonly nodeId: string;
  readonly target: string;
  readonly state: 'closed' | 'open' | 'half_open';
  readonly opened: number;
  /** State changes over time, for a step chart: 0 closed, 1 half-open, 2 open. */
  readonly timeline: readonly { readonly t: number; readonly value: number }[];
}

export interface ReliabilityTelemetry {
  readonly retries: number;
  readonly retriesByReason: Record<string, number>;
  /** Mean attempts per settled client request (1 means no retries were needed). */
  readonly attemptsPerRequest: number;
  readonly callTimeouts: number;
  readonly deadlineTimeouts: number;
  readonly fastFails: number;
  readonly bulkheadRejections: Record<string, number>;
  readonly circuits: readonly CircuitTelemetry[];
  readonly retriesPerSecond: readonly { readonly t: number; readonly value: number }[];
}

const STATE_VALUE = { closed: 0, half_open: 1, open: 2 } as const;

export const reliabilityTelemetry: TelemetryModule<ReliabilityTelemetry> = {
  name: 'reliability',
  levels: {
    RETRY: 'warn',
    CIRCUIT_OPENED: 'error',
    CIRCUIT_HALF_OPENED: 'warn',
    CIRCUIT_CLOSED: 'info',
    CIRCUIT_REJECTED: 'warn',
  },
  describe(event) {
    switch (event.type) {
      case 'RETRY': {
        const p = (event as SimEvent<'RETRY'>).payload;
        return `${p.nodeId} will retry ${p.requestId} (attempt ${p.attempt}) in ${Math.round(p.delayMs)}ms after "${p.reason}" from ${p.previousTarget}`;
      }
      case 'CIRCUIT_OPENED': {
        const p = (event as SimEvent<'CIRCUIT_OPENED'>).payload;
        return p.reopened
          ? `${p.nodeId}'s circuit to ${p.target} re-opened: the probe failed (cooling down ${p.cooldownMs}ms)`
          : `${p.nodeId}'s circuit to ${p.target} opened after ${p.failures} failures${p.calls ? ` in ${p.calls} calls` : ''} (cooling down ${p.cooldownMs}ms)`;
      }
      case 'CIRCUIT_HALF_OPENED': {
        const p = (event as SimEvent<'CIRCUIT_HALF_OPENED'>).payload;
        return `${p.nodeId}'s circuit to ${p.target} is half-open after ${Math.round(p.openForMs)}ms: letting a probe through`;
      }
      case 'CIRCUIT_CLOSED': {
        const p = (event as SimEvent<'CIRCUIT_CLOSED'>).payload;
        return `${p.nodeId}'s circuit to ${p.target} closed: the probe succeeded`;
      }
      case 'CIRCUIT_REJECTED': {
        const p = (event as SimEvent<'CIRCUIT_REJECTED'>).payload;
        return `${p.nodeId} failed ${p.requestId} fast: every circuit (${p.targets.join(', ')}) is open`;
      }
      default:
        return undefined;
    }
  },
  record(event, metrics) {
    switch (event.type) {
      case 'RETRY': {
        const p = (event as SimEvent<'RETRY'>).payload;
        metrics.counter('reliability.retries').add(1, p.reason);
        metrics.timeSeries('reliability.retries').record(event.at);
        return;
      }
      case 'TIMEOUT': {
        const p = (event as SimEvent<'TIMEOUT'>).payload;
        metrics.counter(`reliability.timeouts.${p.scope}`).add(1, p.nodeId);
        return;
      }
      case 'REQUEST_COMPLETED':
      case 'REQUEST_FAILED': {
        const attempts = (event as SimEvent<'REQUEST_COMPLETED'>).payload.attempts;
        metrics.histogram('reliability.attempts').record(attempts);
        return;
      }
      case 'CIRCUIT_REJECTED':
        metrics.counter('reliability.fast_fails').add(1, (event as SimEvent<'CIRCUIT_REJECTED'>).payload.nodeId);
        return;
      case 'CIRCUIT_OPENED':
      case 'CIRCUIT_HALF_OPENED':
      case 'CIRCUIT_CLOSED': {
        const p = (event as SimEvent<'CIRCUIT_CLOSED'>).payload;
        const key = `${p.nodeId}|${p.target}`;
        const state = event.type === 'CIRCUIT_OPENED' ? 'open' : event.type === 'CIRCUIT_HALF_OPENED' ? 'half_open' : 'closed';
        metrics.set('reliability.circuits').add(key);
        // A circuit is closed until something says otherwise.
        const timeline = metrics.timeline(`reliability.circuit.${key}`);
        if (timeline.points().length === 0) timeline.record(0, STATE_VALUE.closed);
        timeline.record(event.at, STATE_VALUE[state]);
        if (state === 'open') metrics.counter(`reliability.opened.${key}`).add();
        return;
      }
      case 'REQUEST_REJECTED': {
        const p = (event as SimEvent<'REQUEST_REJECTED'>).payload;
        if (p.reason === 'bulkhead_full') metrics.counter('reliability.bulkhead').add(1, `${p.nodeId}:${p.bulkhead ?? '?'}`);
        return;
      }
      default:
        return;
    }
  },
  snapshot(metrics) {
    const attempts = metrics.histogram('reliability.attempts').percentiles();
    const circuits: CircuitTelemetry[] = [...metrics.set('reliability.circuits').values()].sort().map((key) => {
      const [nodeId, target] = key.split('|') as [string, string];
      const points = metrics.timeline(`reliability.circuit.${key}`).points();
      const last = points[points.length - 1]?.value ?? 0;
      return {
        nodeId,
        target,
        state: last === 2 ? 'open' : last === 1 ? 'half_open' : 'closed',
        opened: metrics.counter(`reliability.opened.${key}`).total,
        timeline: points.map((p) => ({ t: p.t, value: Number(p.value) })),
      };
    });
    return {
      retries: metrics.counter('reliability.retries').total,
      retriesByReason: metrics.counter('reliability.retries').byLabel(),
      attemptsPerRequest: attempts.count === 0 ? 1 : attempts.mean,
      callTimeouts: metrics.counter('reliability.timeouts.call').total,
      deadlineTimeouts: metrics.counter('reliability.timeouts.deadline').total,
      fastFails: metrics.counter('reliability.fast_fails').total,
      bulkheadRejections: metrics.counter('reliability.bulkhead').byLabel(),
      circuits,
      retriesPerSecond: metrics.timeSeries('reliability.retries').ratePerSecond(),
    };
  },
};
