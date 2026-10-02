import type { RequestBody, Rng, SimNode } from '@distlab/shared';

export interface RoutingContext {
  /** The node deciding where to send the request next. */
  readonly node: SimNode;
  readonly request: RequestBody;
  /** Reachable next hops, already filtered for liveness and loops. */
  readonly candidates: readonly SimNode[];
  readonly rng: Rng;
}

/**
 * Chooses the next hop for a request.
 *
 * This is the seam load-balancing strategies plug into. Round robin, weighted,
 * least-connections and latency-aware selection are a later phase; what matters
 * now is that the choice is made behind an interface rather than hard-coded
 * inside node processing, and that every implementation is a pure function of
 * `(candidates, request, state)` plus an explicit random stream.
 */
export interface DownstreamSelector {
  readonly name: string;
  select(context: RoutingContext): SimNode | undefined;
}

/**
 * Picks the first healthy candidate in topology order.
 *
 * Deliberately the dullest possible rule: with a single downstream it is the
 * only sensible choice, and with several it makes the absence of a real
 * balancing strategy visible in the metrics rather than hiding it behind
 * accidental round-robin.
 */
export const firstAvailable: DownstreamSelector = {
  name: 'first-available',
  select: ({ candidates }) => candidates[0],
};
