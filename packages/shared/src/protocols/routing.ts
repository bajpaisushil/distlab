/**
 * Load-balancing contracts: which downstream a forwarding node picks, the
 * settings that steer that choice, and the event that explains each choice.
 *
 * Any node that forwards — a client spreading calls over several balancers, a
 * load balancer in front of an API tier, an API choosing between shards —
 * balances with its own `routing` strategy over whichever of its downstream
 * neighbours are usable at that instant (up, linked, and eligible for the
 * request). The candidate set therefore changes as nodes crash and recover,
 * and every strategy here is written to stay fair across those changes.
 */
import type { NodeId } from '../ids.js';
import type { SimTime } from '../time.js';
import {
  checkInteger,
  checkOneOf,
  checkPositive,
  type IssueReporter,
  type SpecValidationContext,
} from '../validation.js';

export type RoutingStrategyName =
  /** The first usable candidate in topology (link id) order. No balancing at all — useful as a baseline. */
  | 'first_available'
  /** Each usable candidate in turn, in sorted id order. */
  | 'round_robin'
  /** nginx's smooth weighted round robin over each target's `weight`. */
  | 'weighted_round_robin'
  /** The target with the fewest requests this node has in flight to it. */
  | 'least_connections'
  /** A uniform draw from the node's own random stream. */
  | 'random'
  /** Power of two choices over an EWMA of observed latency, scaled by in-flight load. */
  | 'latency_aware'
  /** A hash ring of virtual nodes, keyed by the request's data key. */
  | 'consistent_hash';

export const ROUTING_STRATEGIES: readonly RoutingStrategyName[] = [
  'first_available',
  'round_robin',
  'weighted_round_robin',
  'least_connections',
  'random',
  'latency_aware',
  'consistent_hash',
];

/**
 * Round robin rather than first-available: a default that silently sends
 * everything to one backend makes every multi-server diagram misleading.
 */
export const DEFAULT_ROUTING_STRATEGY: RoutingStrategyName = 'round_robin';
export const DEFAULT_ROUTING_WEIGHT = 1;
export const DEFAULT_EWMA_ALPHA = 0.3;
/** How long a latency estimate is trusted without a fresh observation. */
export const DEFAULT_EWMA_TTL_MS = 1000;
export const DEFAULT_VIRTUAL_NODES = 100;
/** Ring size is targets × virtualNodes; this keeps a typo from allocating millions of points. */
export const MAX_VIRTUAL_NODES = 10_000;

/**
 * Per-node load-balancing settings. All optional: an unconfigured node uses
 * round robin, and every target weighs 1.
 *
 * `routing`, `ewmaAlpha`, `ewmaTtlMs` and `virtualNodes` are read from the node
 * doing the forwarding; `weight` is read from the node being forwarded *to*,
 * because capacity is a property of the server, not of whoever calls it.
 */
export interface RoutingNodeConfig {
  /** How this node chooses among its usable downstream candidates. Default `round_robin`. */
  routing?: RoutingStrategyName;
  /**
   * This node's relative capacity when an upstream uses `weighted_round_robin`
   * (default 1). Other strategies ignore it — see the module docs for why.
   */
  weight?: number;
  /**
   * `latency_aware` smoothing factor in (0, 1]: how much one new observation
   * moves the estimate. High values chase noise; low values react slowly.
   */
  ewmaAlpha?: number;
  /**
   * `latency_aware`: how long an estimate stays trusted without a fresh
   * observation. After that the target counts as untried again and is
   * probed with a single request — which is how traffic finds its way back
   * to a backend that has recovered.
   */
  ewmaTtlMs?: number;
  /** `consistent_hash`: ring points per target. More points, smoother spread. */
  virtualNodes?: number;
}

export function routingStrategyOf(config: RoutingNodeConfig): RoutingStrategyName {
  return config.routing ?? DEFAULT_ROUTING_STRATEGY;
}

export function routingWeightOf(config: RoutingNodeConfig): number {
  return config.weight ?? DEFAULT_ROUTING_WEIGHT;
}

export function ewmaAlphaOf(config: RoutingNodeConfig): number {
  return config.ewmaAlpha ?? DEFAULT_EWMA_ALPHA;
}

export function ewmaTtlOf(config: RoutingNodeConfig): number {
  return config.ewmaTtlMs ?? DEFAULT_EWMA_TTL_MS;
}

export function virtualNodesOf(config: RoutingNodeConfig): number {
  return config.virtualNodes ?? DEFAULT_VIRTUAL_NODES;
}

/**
 * The canonical order of node ids for routing: digit runs compare by value, so
 * `api-2` comes before `api-10` the way a reader expects, and plain code-unit
 * order breaks the remaining ties so the order is total. Never
 * `localeCompare`: its result depends on the machine's locale, and rotation
 * order must not.
 */
export function compareNodeIds(a: NodeId, b: NodeId): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(j);
    if (isDigit(ca) && isDigit(cb)) {
      const endA = digitRunEnd(a, i);
      const endB = digitRunEnd(b, j);
      const runA = stripLeadingZeros(a.slice(i, endA));
      const runB = stripLeadingZeros(b.slice(j, endB));
      if (runA.length !== runB.length) return runA.length - runB.length;
      if (runA !== runB) return runA < runB ? -1 : 1;
      i = endA;
      j = endB;
      continue;
    }
    if (ca !== cb) return ca - cb;
    i += 1;
    j += 1;
  }
  if (a.length - i !== b.length - j) return a.length - i - (b.length - j);
  return a < b ? -1 : a > b ? 1 : 0;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function digitRunEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && isDigit(text.charCodeAt(end))) end += 1;
  return end;
}

function stripLeadingZeros(run: string): string {
  const stripped = run.replace(/^0+/, '');
  return stripped.length === 0 ? '0' : stripped;
}

/**
 * Which rule actually made a choice. The strategy is what a node is
 * configured with; the rule is what decided this particular request — a
 * consistent-hash node falls back to rotation for a keyless request, a
 * latency-aware node probes an untried target before it compares anything.
 */
export type RoutingRule =
  /** Only one candidate was usable, so there was nothing to choose. */
  | 'sole_candidate'
  /** first_available: the first usable candidate in topology order. */
  | 'first_in_order'
  /** round_robin: the next id after the previous pick. */
  | 'rotation'
  /** weighted_round_robin: the highest current weight (nginx's smooth algorithm). */
  | 'highest_current_weight'
  /** least_connections: the fewest requests in flight; ties continue the rotation. */
  | 'fewest_outstanding'
  /** random: a uniform draw. */
  | 'uniform_draw'
  /** latency_aware: a target with no fresh estimate and nothing in flight gets one probe. */
  | 'probe_untried'
  /** latency_aware: the cheaper of two random candidates, cost = estimate × (in flight + 1). */
  | 'power_of_two_choices'
  /** consistent_hash: the owner of the first ring point at or after the key's hash. */
  | 'hash_ring'
  /** consistent_hash: the request carried no key, so round robin decided. */
  | 'keyless_rotation';

/** Why a configured downstream neighbour was not a candidate. */
export type RoutingExclusionReason =
  /** The node is down. */
  | 'node_failed'
  /** The link to it is cut. A cut link is visible at the sender, unlike a partition. */
  | 'link_down'
  /** Up and reachable, but the data plane ruled it out for this request (e.g. a write to a replica). */
  | 'ineligible';

/** One candidate exactly as the strategy saw it, before this request was counted. */
export interface RoutingCandidateView {
  readonly id: NodeId;
  /** The target's configured weight. Only weighted_round_robin acts on it. */
  readonly weight: number;
  /** Requests this node had sent to the target without yet seeing an outcome. */
  readonly outstanding: number;
  /** weighted_round_robin: current weight after this round's increase — the value compared. */
  readonly currentWeight?: number;
  /** latency_aware: the fresh EWMA latency estimate in ms; absent when untried or expired. */
  readonly ewmaMs?: number;
  /** latency_aware: when this node last saw an outcome from the target. */
  readonly lastSampleAt?: SimTime;
}

export interface RoutingExclusion {
  readonly id: NodeId;
  readonly reason: RoutingExclusionReason;
}

/** A candidate drawn by power of two choices, with the cost it was compared on. */
export interface SampledCandidate {
  readonly id: NodeId;
  readonly cost: number;
}

/** The virtual node of the hash ring that owns a key. */
export interface RingPointView {
  readonly hash: number;
  readonly owner: NodeId;
  /** Which of the owner's virtual nodes this is, 0-based. */
  readonly replica: number;
}

/**
 * Everything needed to explain one load-balancing choice.
 *
 * Emitted by the deciding node immediately after the `REQUEST_ROUTED` it
 * explains — same node, same instant, same target, the very next event — so a
 * reader pairs the two by position. Hops with a single configured downstream
 * have no decision to explain and emit none.
 */
export interface RoutingDecisionPayload {
  /** The forwarding node that chose. */
  readonly nodeId: NodeId;
  readonly strategy: RoutingStrategyName;
  readonly rule: RoutingRule;
  readonly chosen: NodeId;
  /**
   * Every usable candidate in the order the strategy scans them: topology
   * order for first_available, sorted id order for everything else.
   */
  readonly candidates: readonly RoutingCandidateView[];
  /** Configured downstream neighbours that were not candidates, and why. */
  readonly excluded?: readonly RoutingExclusion[];
  /** Rotation-based rules: the previous pick the rotation continued after. Absent when starting fresh. */
  readonly rotatedAfter?: NodeId;
  /** least_connections: every candidate that shared the fewest in flight, when more than one did. */
  readonly tied?: readonly NodeId[];
  /** weighted_round_robin: the total weight the winner's current weight was reduced by. */
  readonly totalWeight?: number;
  /** latency_aware: the two candidates drawn and the costs they were compared on. */
  readonly sampled?: readonly SampledCandidate[];
  /** latency_aware: the estimate assumed for candidates with no fresh one (the mean of the fresh ones). */
  readonly priorMs?: number;
  /** consistent_hash: the request's data key. */
  readonly key?: string;
  /** consistent_hash: the key's 32-bit MurmurHash3 — its position on the ring. */
  readonly keyHash?: number;
  /** consistent_hash: the virtual node that owns the key. */
  readonly ringPoint?: RingPointView;
  /** consistent_hash: ring points per target on this ring. */
  readonly virtualNodes?: number;
}

export interface RoutingEventPayloads {
  /** Why a forwarding node sent a request where it did. */
  ROUTING_DECISION: RoutingDecisionPayload;
}

export function validateRoutingConfig(
  config: RoutingNodeConfig,
  path: string,
  push: IssueReporter,
  _context: SpecValidationContext,
): void {
  // Values arrive from untrusted JSON; the static type is a hope, not a fact.
  const raw = config as Record<keyof RoutingNodeConfig, unknown>;
  checkOneOf(raw.routing, ROUTING_STRATEGIES, `${path}.routing`, push);
  checkPositive(raw.weight, `${path}.weight`, push, true);
  if (
    raw.ewmaAlpha !== undefined &&
    (typeof raw.ewmaAlpha !== 'number' || !Number.isFinite(raw.ewmaAlpha) || raw.ewmaAlpha <= 0 || raw.ewmaAlpha > 1)
  ) {
    push(`${path}.ewmaAlpha`, 'must be a number greater than 0 and at most 1');
  }
  checkPositive(raw.ewmaTtlMs, `${path}.ewmaTtlMs`, push, true);
  checkInteger(raw.virtualNodes, `${path}.virtualNodes`, push, 1);
  if (typeof raw.virtualNodes === 'number' && raw.virtualNodes > MAX_VIRTUAL_NODES) {
    push(`${path}.virtualNodes`, `must be at most ${MAX_VIRTUAL_NODES}`);
  }
}
