import type { LinkId, NodeId, WorkloadId } from './ids.js';
import { validateFault, type FaultSpec } from './faults.js';
import type { LinkConfig, PartitionSpec } from './network-types.js';
import type { NodeConfig, NodeStatus, NodeType } from './nodes.js';
import type { OperationType } from './messages.js';
import type { SimTime } from './time.js';
import { DEFAULT_LINK_CONFIG } from './network-types.js';
import { DEFAULT_NODE_CONFIG, NODE_TYPE_DEFAULTS } from './nodes.js';
import {
  checkLatency,
  checkNonNegative,
  checkPositive,
  checkProbability,
  type IssueReporter,
  type SpecValidationContext,
} from './validation.js';
import { validateReliabilityConfig } from './protocols/requests.js';
import { validateRoutingConfig } from './protocols/routing.js';
import { validateDataConfig } from './protocols/data.js';
import { validateQueueConfig } from './protocols/queue.js';
import { validateConsensusConfig } from './protocols/consensus.js';
import { validateLockConfig } from './protocols/locks.js';

/** Bumped when the on-disk shape changes incompatibly. */
export const SPEC_VERSION = 1;

export interface NodeSpec {
  id: NodeId;
  type: NodeType;
  label?: string;
  config?: Partial<NodeConfig>;
  metadata?: Record<string, string | number | boolean>;
  /** Initial status; lets a scenario start with a node already down. */
  status?: NodeStatus;
}

export interface LinkSpec extends Partial<Omit<LinkConfig, 'id' | 'from' | 'to'>> {
  id?: LinkId;
  from: NodeId;
  to: NodeId;
}

export type ArrivalSpec =
  /** A fixed number of requests, all at `startAt`. */
  | { kind: 'once'; count: number }
  /** Evenly spaced requests at a steady rate. */
  | { kind: 'constant'; ratePerSec: number }
  /** Exponentially distributed gaps — bursty in the way real traffic is. */
  | { kind: 'poisson'; ratePerSec: number }
  /** `count` requests at once, repeating every `everyMs`. */
  | { kind: 'burst'; count: number; everyMs: number };

export interface WorkloadSpec {
  id: WorkloadId;
  clientId: NodeId;
  operation: OperationType;
  arrival: ArrivalSpec;
  sizeBytes?: number;
  startAt?: SimTime;
  stopAt?: SimTime;
  maxRequests?: number;
  /** How long the client waits before abandoning a request. */
  deadlineMs?: number;
  /**
   * A weighted mix of operations instead of a single one — e.g. 90% reads and
   * 10% writes. When set, `operation` is only the label for the workload.
   */
  mix?: { operation: OperationType; weight: number }[];
  /** Size of the key space storage operations draw from (`key-0` .. `key-N-1`). */
  keys?: number;
  /** Fraction of requests aimed at `key-0`, to model a hot key. */
  hotKeyShare?: number;
}

/**
 * The complete, serialisable description of a run.
 *
 * This is the export/import unit: the same JSON plus the same engine version
 * reproduces a run exactly, which is what makes shared scenarios and bug
 * reports meaningful.
 */
export interface SimulationSpec {
  version: typeof SPEC_VERSION;
  id: string;
  name: string;
  description?: string;
  seed: string | number;
  /** Virtual time at which the run stops. */
  durationMs?: number;
  /** Hard cap on processed events, as a runaway guard. */
  maxEvents?: number;
  nodes: NodeSpec[];
  links: LinkSpec[];
  workloads: WorkloadSpec[];
  /** Partitions active from the first instant of the run. */
  partitions?: PartitionSpec[];
  /** Faults scheduled to happen partway through the run. */
  faults?: FaultSpec[];
  /** Canvas positions. Presentation only — the engine never reads it. */
  layout?: Record<NodeId, { x: number; y: number }>;
  /** What a learner should come away understanding. */
  learningObjectives?: string[];
  /** Things worth watching while it runs. */
  observe?: string[];
  category?: string;
  tags?: string[];
}

export interface ResolvedNodeSpec {
  readonly id: NodeId;
  readonly type: NodeType;
  readonly label: string;
  readonly config: NodeConfig;
  readonly metadata: Record<string, string | number | boolean>;
  readonly status: NodeStatus;
}

export interface ResolvedWorkloadSpec
  extends Required<Omit<WorkloadSpec, 'stopAt' | 'mix' | 'keys' | 'hotKeyShare'>> {
  readonly stopAt: SimTime | undefined;
  readonly mix: readonly { operation: OperationType; weight: number }[];
  readonly keys: number;
  readonly hotKeyShare: number;
}

export interface ResolvedSpec {
  readonly version: typeof SPEC_VERSION;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly seed: string;
  readonly durationMs: number;
  readonly maxEvents: number;
  readonly nodes: readonly ResolvedNodeSpec[];
  readonly links: readonly LinkConfig[];
  readonly workloads: readonly ResolvedWorkloadSpec[];
  readonly partitions: readonly PartitionSpec[];
  readonly faults: readonly ResolvedFaultSpec[];
  readonly learningObjectives: readonly string[];
  readonly observe: readonly string[];
}

export type ResolvedFaultSpec = FaultSpec & { readonly id: string };

export const DEFAULT_DURATION_MS = 60_000;
export const DEFAULT_MAX_EVENTS = 1_000_000;
export const DEFAULT_REQUEST_DEADLINE_MS = 5_000;

export interface SpecIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly SpecIssue[];
}

export function linkIdFor(from: NodeId, to: NodeId): LinkId {
  return `${from}->${to}`;
}

/**
 * Validates a spec before it is ever handed to the engine.
 *
 * Validation is hand-written rather than schema-library driven: the rules are
 * mostly cross-references (does this link point at a node that exists?) that a
 * generic schema cannot express anyway, and it keeps the dependency count at
 * zero for a package the whole system depends on.
 */
export function validateSimulationSpec(input: unknown): ValidationResult {
  const errors: SpecIssue[] = [];
  const push = (path: string, message: string) => errors.push({ path, message });

  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: [{ path: '', message: 'spec must be an object' }] };
  }
  const spec = input as Partial<SimulationSpec>;

  if (spec.version !== SPEC_VERSION) {
    push('version', `expected version ${SPEC_VERSION}, received ${JSON.stringify(spec.version)}`);
  }
  if (typeof spec.id !== 'string' || spec.id.length === 0) push('id', 'must be a non-empty string');
  if (typeof spec.name !== 'string' || spec.name.length === 0) push('name', 'must be a non-empty string');
  if (typeof spec.seed !== 'string' && typeof spec.seed !== 'number') {
    push('seed', 'must be a string or number');
  }
  checkPositive(spec.durationMs, 'durationMs', push, true);
  checkPositive(spec.maxEvents, 'maxEvents', push, true);

  const nodeIds = new Set<NodeId>();
  const nodeTypes = new Map<NodeId, NodeType>();
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    push('nodes', 'must be a non-empty array');
  } else {
    spec.nodes.forEach((node, i) => {
      const path = `nodes[${i}]`;
      if (typeof node?.id !== 'string' || node.id.length === 0) {
        push(`${path}.id`, 'must be a non-empty string');
        return;
      }
      if (nodeIds.has(node.id)) push(`${path}.id`, `duplicate node id "${node.id}"`);
      nodeIds.add(node.id);
      if (!(node.type in NODE_TYPE_DEFAULTS)) {
        push(`${path}.type`, `unknown node type "${String(node.type)}"`);
      } else {
        nodeTypes.set(node.id, node.type);
      }
      const cfg = node.config;
      if (cfg) {
        checkPositive(cfg.concurrency, `${path}.config.concurrency`, push, true);
        checkNonNegative(cfg.queueCapacity, `${path}.config.queueCapacity`, push);
        checkProbability(cfg.failureProbability, `${path}.config.failureProbability`, push);
        checkLatency(cfg.processing, `${path}.config.processing`, push);
        checkLatency(cfg.readLatency, `${path}.config.readLatency`, push);
        checkLatency(cfg.writeLatency, `${path}.config.writeLatency`, push);
      }
    });
  }

  const linkIds = new Set<LinkId>();
  const resolvedLinks: { id: LinkId; from: NodeId; to: NodeId }[] = [];
  if (!Array.isArray(spec.links)) {
    push('links', 'must be an array');
  } else {
    spec.links.forEach((link, i) => {
      const path = `links[${i}]`;
      if (typeof link?.from !== 'string' || typeof link?.to !== 'string') {
        push(path, 'from and to must be node ids');
        return;
      }
      if (!nodeIds.has(link.from)) push(`${path}.from`, `unknown node "${link.from}"`);
      if (!nodeIds.has(link.to)) push(`${path}.to`, `unknown node "${link.to}"`);
      if (link.from === link.to) push(path, 'a link cannot connect a node to itself');
      const id = link.id ?? linkIdFor(link.from, link.to);
      if (linkIds.has(id)) push(`${path}.id`, `duplicate link id "${id}"`);
      linkIds.add(id);
      resolvedLinks.push({ id, from: link.from, to: link.to });
      checkProbability(link.lossRate, `${path}.lossRate`, push);
      checkProbability(link.duplicateRate, `${path}.duplicateRate`, push);
      checkProbability(link.reorderRate, `${path}.reorderRate`, push);
      checkNonNegative(link.bandwidthBytesPerSec, `${path}.bandwidthBytesPerSec`, push);
      checkLatency(link.latency, `${path}.latency`, push);
      checkLatency(link.reorderDelay, `${path}.reorderDelay`, push);
    });
  }

  const context: SpecValidationContext = { nodeIds, nodeTypes, linkIds, links: resolvedLinks };

  // Subsystem settings are validated once every node and link is known,
  // because most of their rules are cross-references.
  if (Array.isArray(spec.nodes)) {
    spec.nodes.forEach((node, i) => {
      const cfg = node?.config;
      if (!cfg || typeof cfg !== 'object') return;
      const path = `nodes[${i}].config`;
      const own: SpecValidationContext = { ...context, self: { id: node.id, type: node.type } };
      validateRoutingConfig(cfg, path, push, own);
      validateDataConfig(cfg, path, push, own);
      validateReliabilityConfig(cfg, path, push, own);
      validateQueueConfig(cfg, path, push, own);
      validateConsensusConfig(cfg, path, push, own);
      validateLockConfig(cfg, path, push, own);
    });
  }

  // Every pair of consensus nodes in a cluster needs a link: votes and log
  // entries travel over the network like everything else.
  if (Array.isArray(spec.nodes)) {
    const clusters = new Map<string, NodeId[]>();
    for (const node of spec.nodes) {
      if (node?.type !== 'consensus' || typeof node.id !== 'string') continue;
      const clusterId = (node.config?.consensus?.clusterId as string | undefined) ?? 'raft';
      clusters.set(clusterId, [...(clusters.get(clusterId) ?? []), node.id]);
    }
    for (const [clusterId, members] of clusters) {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = members[i]!;
          const b = members[j]!;
          const linked = resolvedLinks.some((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a));
          if (!linked) push('links', `consensus cluster "${clusterId}" needs a link between ${a} and ${b}`);
        }
      }
    }
  }

  const workloadIds = new Set<WorkloadId>();
  if (!Array.isArray(spec.workloads)) {
    push('workloads', 'must be an array');
  } else {
    spec.workloads.forEach((w, i) => {
      const path = `workloads[${i}]`;
      if (typeof w?.id !== 'string' || w.id.length === 0) {
        push(`${path}.id`, 'must be a non-empty string');
      } else {
        if (workloadIds.has(w.id)) push(`${path}.id`, `duplicate workload id "${w.id}"`);
        workloadIds.add(w.id);
      }
      if (typeof w?.clientId !== 'string' || !nodeIds.has(w.clientId)) {
        push(`${path}.clientId`, `unknown node "${String(w?.clientId)}"`);
      }
      if (typeof w?.operation !== 'string' || w.operation.length === 0) {
        push(`${path}.operation`, 'must be a non-empty string');
      }
      checkNonNegative(w?.startAt, `${path}.startAt`, push);
      checkNonNegative(w?.stopAt, `${path}.stopAt`, push);
      checkPositive(w?.maxRequests, `${path}.maxRequests`, push, true);
      checkNonNegative(w?.sizeBytes, `${path}.sizeBytes`, push);
      checkPositive(w?.deadlineMs, `${path}.deadlineMs`, push, true);
      validateArrival(w?.arrival, `${path}.arrival`, push);
      if (w?.keys !== undefined && (!Number.isInteger(w.keys) || w.keys < 1)) {
        push(`${path}.keys`, 'must be an integer of at least 1');
      }
      checkProbability(w?.hotKeyShare, `${path}.hotKeyShare`, push);
      if (w?.mix !== undefined) {
        if (!Array.isArray(w.mix) || w.mix.length === 0) {
          push(`${path}.mix`, 'must be a non-empty array');
        } else {
          w.mix.forEach((entry, m) => {
            if (typeof entry?.operation !== 'string' || entry.operation.length === 0) {
              push(`${path}.mix[${m}].operation`, 'must be a non-empty string');
            }
            checkPositive(entry?.weight, `${path}.mix[${m}].weight`, push, false);
          });
        }
      }
    });
  }

  if (spec.partitions !== undefined) {
    if (!Array.isArray(spec.partitions)) {
      push('partitions', 'must be an array');
    } else {
      spec.partitions.forEach((p, i) => {
        const path = `partitions[${i}]`;
        if (typeof p?.id !== 'string' || p.id.length === 0) push(`${path}.id`, 'must be a non-empty string');
        if (!Array.isArray(p?.groups) || p.groups.length < 2) {
          push(`${path}.groups`, 'a partition needs at least two groups');
          return;
        }
        p.groups.forEach((group, g) => {
          if (!Array.isArray(group) || group.length === 0) {
            push(`${path}.groups[${g}]`, 'must be a non-empty array of node ids');
            return;
          }
          group.forEach((id, n) => {
            if (!nodeIds.has(id)) push(`${path}.groups[${g}][${n}]`, `unknown node "${id}"`);
          });
        });
      });
    }
  }

  if (spec.faults !== undefined) {
    if (!Array.isArray(spec.faults)) {
      push('faults', 'must be an array');
    } else {
      const faultIds = new Set<string>();
      spec.faults.forEach((fault, i) => {
        validateFault(fault, `faults[${i}]`, push, context, faultIds);
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Applies type defaults and derived ids so the engine only ever sees complete configuration. */
export function resolveSimulationSpec(spec: SimulationSpec): ResolvedSpec {
  const nodes = spec.nodes.map<ResolvedNodeSpec>((node) => ({
    id: node.id,
    type: node.type,
    label: node.label ?? node.id,
    config: { ...DEFAULT_NODE_CONFIG, ...NODE_TYPE_DEFAULTS[node.type], ...node.config },
    metadata: { ...node.metadata },
    status: node.status ?? 'healthy',
  }));

  const links = spec.links.map<LinkConfig>((link) => ({
    ...DEFAULT_LINK_CONFIG,
    ...stripUndefined(link),
    id: link.id ?? linkIdFor(link.from, link.to),
    from: link.from,
    to: link.to,
  }));

  const workloads = spec.workloads.map<ResolvedWorkloadSpec>((w) => ({
    id: w.id,
    clientId: w.clientId,
    operation: w.operation,
    arrival: w.arrival,
    sizeBytes: w.sizeBytes ?? 512,
    deadlineMs: w.deadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS,
    mix: w.mix ?? [{ operation: w.operation, weight: 1 }],
    // 0 means unkeyed: the workload's requests carry no storage key.
    keys: w.keys ?? 0,
    hotKeyShare: w.hotKeyShare ?? 0,
    startAt: w.startAt ?? 0,
    stopAt: w.stopAt,
    maxRequests: w.maxRequests ?? Number.POSITIVE_INFINITY,
  }));

  return {
    version: SPEC_VERSION,
    id: spec.id,
    name: spec.name,
    description: spec.description ?? '',
    seed: String(spec.seed),
    durationMs: spec.durationMs ?? DEFAULT_DURATION_MS,
    maxEvents: spec.maxEvents ?? DEFAULT_MAX_EVENTS,
    nodes,
    links,
    workloads,
    partitions: spec.partitions ?? [],
    faults: (spec.faults ?? []).map((fault, index) => ({ ...fault, id: fault.id ?? `fault-${index + 1}` })),
    learningObjectives: spec.learningObjectives ?? [],
    observe: spec.observe ?? [],
  };
}

/** Parses exported scenario JSON, validating before it can reach the engine. */
export function parseSimulationSpec(json: string): { spec: SimulationSpec } | { errors: readonly SpecIssue[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { errors: [{ path: '', message: `invalid JSON: ${(error as Error).message}` }] };
  }
  const result = validateSimulationSpec(parsed);
  if (!result.valid) return { errors: result.errors };
  return { spec: parsed as SimulationSpec };
}

export function serializeSimulationSpec(spec: SimulationSpec): string {
  return JSON.stringify(spec, null, 2);
}

type Push = IssueReporter;

function validateArrival(arrival: ArrivalSpec | undefined, path: string, push: Push): void {
  if (!arrival || typeof arrival !== 'object') {
    push(path, 'must be an arrival spec');
    return;
  }
  switch (arrival.kind) {
    case 'once':
      checkPositive(arrival.count, `${path}.count`, push, false);
      return;
    case 'constant':
    case 'poisson':
      checkPositive(arrival.ratePerSec, `${path}.ratePerSec`, push, false);
      return;
    case 'burst':
      checkPositive(arrival.count, `${path}.count`, push, false);
      checkPositive(arrival.everyMs, `${path}.everyMs`, push, false);
      return;
    default:
      push(`${path}.kind`, `unknown arrival kind "${String((arrival as { kind: string }).kind)}"`);
  }
}





function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
