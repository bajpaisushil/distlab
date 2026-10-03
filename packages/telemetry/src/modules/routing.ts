import type { SimEvent } from '@distlab/shared';
import type { TelemetryModule } from './types.js';

export interface RoutingTargetShare {
  readonly id: string;
  readonly dispatched: number;
  readonly share: number;
}

export interface RoutingNodeTelemetry {
  readonly nodeId: string;
  readonly strategy: string;
  readonly total: number;
  /** Every target the node could choose, including any that never received a request. */
  readonly targets: readonly RoutingTargetShare[];
  /** Coefficient of variation of dispatch counts: 0 is perfectly even. */
  readonly imbalance: number;
}

export interface RoutingTelemetry {
  readonly nodes: readonly RoutingNodeTelemetry[];
}

const DISPATCH = 'routing.dispatch.';

export const routingTelemetry: TelemetryModule<RoutingTelemetry> = {
  name: 'routing',
  levels: { ROUTING_DECISION: 'debug' },
  describe(event) {
    if (event.type !== 'ROUTING_DECISION') return undefined;
    const p = (event as SimEvent<'ROUTING_DECISION'>).payload;
    const why: Record<string, string> = {
      sole_candidate: 'the only usable target',
      first_in_order: 'first usable in order',
      rotation: p.rotatedAfter ? `next after ${p.rotatedAfter}` : 'start of rotation',
      highest_current_weight: 'highest current weight',
      fewest_outstanding: `fewest in flight${p.tied ? ` (tied: ${p.tied.join(', ')})` : ''}`,
      uniform_draw: 'random draw',
      probe_untried: 'probing a target with no fresh latency estimate',
      power_of_two_choices: p.sampled ? `cheaper of ${p.sampled.map((s) => `${s.id} (${Math.round(s.cost)})`).join(' vs ')}` : 'power of two choices',
      hash_ring: `owner of key "${p.key}" on the hash ring`,
      keyless_rotation: 'no key, so rotation',
    };
    const excluded = p.excluded?.length ? `; skipped ${p.excluded.map((x) => `${x.id} (${x.reason.replace(/_/g, ' ')})`).join(', ')}` : '';
    return `${p.nodeId} chose ${p.chosen} by ${p.strategy.replace(/_/g, ' ')}: ${why[p.rule] ?? p.rule}${excluded}`;
  },
  record(event, metrics) {
    if (event.type === 'REQUEST_ROUTED') {
      const p = (event as SimEvent<'REQUEST_ROUTED'>).payload;
      metrics.counter(`${DISPATCH}${p.from}`).add(1, p.to);
      metrics.counter(`routing.strategy.${p.from}`).add(1, p.strategy);
    } else if (event.type === 'ROUTING_DECISION') {
      const p = (event as SimEvent<'ROUTING_DECISION'>).payload;
      const candidates = metrics.set(`routing.candidates.${p.nodeId}`);
      for (const c of p.candidates) candidates.add(c.id);
      for (const x of p.excluded ?? []) candidates.add(x.id);
    }
  },
  snapshot(metrics) {
    const nodes: RoutingNodeTelemetry[] = [];
    for (const name of metrics.names('counter', DISPATCH)) {
      const nodeId = name.slice(DISPATCH.length);
      const dispatched = metrics.counter(name).byLabel();
      const ids = new Set([...Object.keys(dispatched), ...metrics.set(`routing.candidates.${nodeId}`).values()]);
      // A single-target hop has nothing to balance.
      if (ids.size < 2) continue;
      const total = metrics.counter(name).total;
      const targets = [...ids].sort().map((id) => ({ id, dispatched: dispatched[id] ?? 0, share: total === 0 ? 0 : (dispatched[id] ?? 0) / total }));
      const mean = total / targets.length;
      const variance = targets.reduce((sum, t) => sum + (t.dispatched - mean) ** 2, 0) / targets.length;
      const strategies = metrics.counter(`routing.strategy.${nodeId}`).byLabel();
      const strategy = Object.entries(strategies).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
      nodes.push({ nodeId, strategy, total, targets, imbalance: mean === 0 ? 0 : Math.sqrt(variance) / mean });
    }
    return { nodes };
  },
};
