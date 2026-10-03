import {
  buildRing,
  ewma,
  leastOutstanding,
  murmur3,
  nextInRotation,
  powerOfTwoChoices,
  ringLookup,
  smoothWeighted,
  uniform,
  type RingPoint,
} from '@distlab/algorithms';
import {
  compareNodeIds,
  ewmaAlphaOf,
  ewmaTtlOf,
  routingStrategyOf,
  routingWeightOf,
  virtualNodesOf,
  type NodeId,
  type RequestBody,
  type RoutingCandidateView,
  type RoutingDecisionPayload,
  type RoutingStrategyName,
  type SimNode,
} from '@distlab/shared';
import type { DispatchContext, ModuleServices, RoutingExclusionView, RoutingPolicy } from './types.js';

/** What one forwarding node remembers about its downstream targets. */
interface NodeRouting {
  /** The previous pick, for every rotation-based rule. */
  last: NodeId | undefined;
  /** Smooth weighted round robin's current weights. */
  readonly current: Map<NodeId, number>;
  /** Requests sent to each target without an outcome yet. */
  readonly outstanding: Map<NodeId, number>;
  /** Latency estimates and when each was last refreshed. */
  readonly estimates: Map<NodeId, { value: number; at: number }>;
}

interface RoutingState {
  readonly nodes: readonly (readonly [
    NodeId,
    {
      readonly last: NodeId | undefined;
      readonly current: readonly (readonly [NodeId, number])[];
      readonly outstanding: readonly (readonly [NodeId, number])[];
      readonly estimates: readonly (readonly [NodeId, { value: number; at: number }])[];
    },
  ])[];
}

/**
 * Load balancing for every forwarding node.
 *
 * Each node balances with its own configured strategy over whichever of its
 * downstream neighbours are usable at that instant. The runtime reports every
 * dispatch and every outcome back here, so stateful strategies — least
 * connections, latency-aware — act on exactly the traffic the node really
 * sent, including requests that timed out. Each multi-candidate choice is
 * explained by a ROUTING_DECISION event right after its REQUEST_ROUTED.
 */
export function createRoutingPolicy(services: ModuleServices): RoutingPolicy {
  let nodes = new Map<NodeId, NodeRouting>();
  const rings = new Map<string, RingPoint[]>();
  /** The decision awaiting its dispatch, so it can be emitted after REQUEST_ROUTED. */
  let pending: { nodeId: NodeId; payload: RoutingDecisionPayload } | undefined;

  const stateOf = (id: NodeId): NodeRouting => {
    let state = nodes.get(id);
    if (!state) {
      state = { last: undefined, current: new Map(), outstanding: new Map(), estimates: new Map() };
      nodes.set(id, state);
    }
    return state;
  };

  const ringFor = (ids: readonly NodeId[], virtualNodes: number): RingPoint[] => {
    const key = `${virtualNodes}|${ids.join(',')}`;
    let ring = rings.get(key);
    if (!ring) {
      ring = buildRing(ids, virtualNodes);
      if (rings.size > 64) rings.clear();
      rings.set(key, ring);
    }
    return ring;
  };

  const freshEstimate = (state: NodeRouting, id: NodeId, ttl: number): number | undefined => {
    const estimate = state.estimates.get(id);
    if (!estimate) return undefined;
    return services.context.now() - estimate.at <= ttl ? estimate.value : undefined;
  };

  return {
    strategyName: (node) => routingStrategyOf(node.config),

    select(node: SimNode, body: RequestBody, candidates: readonly SimNode[], excluded: readonly RoutingExclusionView[] = []) {
      pending = undefined;
      if (candidates.length === 0) return undefined;
      const strategy = routingStrategyOf(node.config);
      const state = stateOf(node.id);
      const byId = new Map(candidates.map((c) => [c.id, c]));
      // Topology order for first_available; everything else scans a stable sorted order.
      const sorted = strategy === 'first_available' ? candidates.map((c) => c.id) : candidates.map((c) => c.id).sort(compareNodeIds);
      const views = (extra?: (id: NodeId) => Partial<RoutingCandidateView>): RoutingCandidateView[] =>
        sorted.map((id) => ({
          id,
          weight: routingWeightOf(byId.get(id)!.config),
          outstanding: state.outstanding.get(id) ?? 0,
          ...(extra ? extra(id) : {}),
        }));
      const decide = (chosen: NodeId, rule: RoutingDecisionPayload['rule'], details: Partial<RoutingDecisionPayload> = {}, candidateViews = views()) => {
        if (sorted.length > 1 || excluded.length > 0) {
          pending = {
            nodeId: node.id,
            payload: {
              nodeId: node.id,
              strategy,
              rule: sorted.length === 1 ? 'sole_candidate' : rule,
              chosen,
              candidates: candidateViews,
              ...(excluded.length > 0 ? { excluded } : {}),
              ...details,
            },
          };
        }
        return byId.get(chosen);
      };

      if (sorted.length === 1) {
        state.last = sorted[0];
        return decide(sorted[0]!, 'sole_candidate');
      }

      switch (strategy as RoutingStrategyName) {
        case 'first_available':
          return decide(sorted[0]!, 'first_in_order');

        case 'round_robin': {
          const after = state.last;
          const chosen = nextInRotation(sorted, after, compareNodeIds)!;
          state.last = chosen;
          return decide(chosen, 'rotation', after !== undefined ? { rotatedAfter: after } : {});
        }

        case 'weighted_round_robin': {
          const result = smoothWeighted(
            sorted.map((id) => ({ id, weight: routingWeightOf(byId.get(id)!.config) })),
            state.current,
          )!;
          for (const [id, value] of result.next) state.current.set(id, value);
          state.last = result.chosen;
          return decide(result.chosen, 'highest_current_weight', { totalWeight: result.total }, views((id) => ({ currentWeight: result.compared.get(id) ?? 0 })));
        }

        case 'least_connections': {
          const after = state.last;
          const result = leastOutstanding(sorted, state.outstanding, after, compareNodeIds)!;
          state.last = result.chosen;
          return decide(result.chosen, 'fewest_outstanding', {
            ...(result.tied.length > 1 ? { tied: result.tied } : {}),
            ...(result.tied.length > 1 && after !== undefined ? { rotatedAfter: after } : {}),
          });
        }

        case 'random': {
          const chosen = uniform(sorted, services.rng('routing', node.id))!;
          state.last = chosen;
          return decide(chosen, 'uniform_draw');
        }

        case 'latency_aware': {
          const ttl = ewmaTtlOf(node.config);
          const estimates = new Map(sorted.map((id) => [id, freshEstimate(state, id, ttl)]));
          const viewsWithEstimates = views((id) => {
            const estimate = state.estimates.get(id);
            const fresh = estimates.get(id);
            return {
              ...(fresh !== undefined ? { ewmaMs: fresh } : {}),
              ...(estimate ? { lastSampleAt: estimate.at } : {}),
            };
          });
          // An untried (or long-unheard-from) target gets one probe before it is judged.
          const untried = sorted.filter((id) => estimates.get(id) === undefined && (state.outstanding.get(id) ?? 0) === 0);
          if (untried.length > 0) {
            const after = state.last;
            const chosen = nextInRotation(untried, after, compareNodeIds)!;
            state.last = chosen;
            return decide(chosen, 'probe_untried', after !== undefined ? { rotatedAfter: after } : {}, viewsWithEstimates);
          }
          const known = [...estimates.values()].filter((v): v is number => v !== undefined);
          const prior = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 1;
          const result = powerOfTwoChoices(
            sorted.map((id) => ({ id, outstanding: state.outstanding.get(id) ?? 0, estimate: estimates.get(id) })),
            services.rng('routing', node.id),
            prior,
          )!;
          state.last = result.chosen;
          return decide(result.chosen, 'power_of_two_choices', { sampled: result.sampled, priorMs: prior }, viewsWithEstimates);
        }

        case 'consistent_hash': {
          if (body.key === undefined) {
            const after = state.last;
            const chosen = nextInRotation(sorted, after, compareNodeIds)!;
            state.last = chosen;
            return decide(chosen, 'keyless_rotation', after !== undefined ? { rotatedAfter: after } : {});
          }
          const virtualNodes = virtualNodesOf(node.config);
          const keyHash = murmur3(body.key);
          const point = ringLookup(ringFor(sorted, virtualNodes), keyHash)!;
          state.last = point.owner;
          return decide(point.owner, 'hash_ring', {
            key: body.key,
            keyHash,
            ringPoint: { hash: point.hash, owner: point.owner, replica: point.replica },
            virtualNodes,
          });
        }
      }
    },

    onDispatch(node: SimNode, target: NodeId, context: DispatchContext = {}) {
      const state = stateOf(node.id);
      state.outstanding.set(target, (state.outstanding.get(target) ?? 0) + 1);
      if (pending && pending.nodeId === node.id && pending.payload.chosen === target) {
        services.emit('ROUTING_DECISION', pending.payload, {
          nodeId: node.id,
          ...(context.traceId !== undefined ? { traceId: context.traceId } : {}),
          ...(context.causedBy !== undefined ? { causedBy: context.causedBy } : {}),
        });
      }
      pending = undefined;
    },

    onOutcome(node: SimNode, target: NodeId, latencyMs: number, ok: boolean) {
      const state = stateOf(node.id);
      const outstanding = state.outstanding.get(target) ?? 0;
      if (outstanding > 0) state.outstanding.set(target, outstanding - 1);
      if (routingStrategyOf(node.config) !== 'latency_aware') return;
      // An expired estimate does not anchor the new one: the point of letting
      // it expire is to judge the target afresh, e.g. after it has recovered.
      const previous = freshEstimate(state, target, ewmaTtlOf(node.config));
      // A failure is evidence the target is a bad choice: count it as twice as
      // slow as the worse of what was observed and what was expected.
      const sample = ok ? latencyMs : Math.max(latencyMs, 2 * (previous ?? latencyMs));
      state.estimates.set(target, { value: ewma(previous, sample, ewmaAlphaOf(node.config)), at: services.context.now() });
    },

    captureState(): RoutingState {
      return {
        nodes: [...nodes.entries()].map(([id, s]) => [
          id,
          {
            last: s.last,
            current: [...s.current.entries()],
            outstanding: [...s.outstanding.entries()],
            estimates: [...s.estimates.entries()].map(([t, e]) => [t, { ...e }] as const),
          },
        ]),
      };
    },

    restoreState(raw: unknown) {
      const state = raw as RoutingState;
      nodes = new Map();
      pending = undefined;
      for (const [id, s] of state.nodes ?? []) {
        nodes.set(id, {
          last: s.last,
          current: new Map(s.current),
          outstanding: new Map(s.outstanding),
          estimates: new Map(s.estimates.map(([t, e]) => [t, { ...e }])),
        });
      }
    },
  };
}
