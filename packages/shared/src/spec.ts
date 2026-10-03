import type { LinkId, NodeId, WorkloadId } from './ids.js';
import type { LatencySpec } from './latency.js';
import type { FaultSpec } from './faults.js';
import type { LinkConfig, PartitionSpec } from './network-types.js';
import type { NodeConfig, NodeStatus, NodeType } from './nodes.js';
import type { OperationType } from './messages.js';
import type { SimTime } from './time.js';
import { DEFAULT_LINK_CONFIG } from './network-types.js';
import { DEFAULT_NODE_CONFIG, NODE_TYPE_DEFAULTS } from './nodes.js';

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
}

export interface ResolvedNodeSpec {
  readonly id: NodeId;
  readonly type: NodeType;
  readonly label: string;
  readonly config: NodeConfig;
  readonly metadata: Record<string, string | number | boolean>;
  readonly status: NodeStatus;
}

export interface ResolvedWorkloadSpec extends Required<Omit<WorkloadSpec, 'stopAt'>> {
  readonly stopAt: SimTime | undefined;
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
      checkProbability(link.lossRate, `${path}.lossRate`, push);
      checkProbability(link.duplicateRate, `${path}.duplicateRate`, push);
      checkProbability(link.reorderRate, `${path}.reorderRate`, push);
      checkNonNegative(link.bandwidthBytesPerSec, `${path}.bandwidthBytesPerSec`, push);
      checkLatency(link.latency, `${path}.latency`, push);
      checkLatency(link.reorderDelay, `${path}.reorderDelay`, push);
    });
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
        validateFault(fault, `faults[${i}]`, nodeIds, linkIds, faultIds, push);
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateFault(
  fault: FaultSpec | undefined,
  path: string,
  nodeIds: ReadonlySet<NodeId>,
  linkIds: ReadonlySet<LinkId>,
  seen: Set<string>,
  push: Push,
): void {
  if (!fault || typeof fault !== 'object') {
    push(path, 'must be a fault spec');
    return;
  }
  if (fault.id !== undefined) {
    if (seen.has(fault.id)) push(`${path}.id`, `duplicate fault id "${fault.id}"`);
    seen.add(fault.id);
  }
  checkNonNegative(fault.at, `${path}.at`, push);
  if (fault.at === undefined) push(`${path}.at`, 'is required');

  const requireNode = (id: NodeId | undefined, field: string) => {
    if (typeof id !== 'string' || !nodeIds.has(id)) push(`${path}.${field}`, `unknown node "${String(id)}"`);
  };
  const requireLink = (id: LinkId | undefined, field: string) => {
    if (typeof id !== 'string' || !linkIds.has(id)) push(`${path}.${field}`, `unknown link "${String(id)}"`);
  };

  switch (fault.kind) {
    case 'node_crash':
      requireNode(fault.nodeId, 'nodeId');
      checkPositive(fault.recoverAfter, `${path}.recoverAfter`, push, true);
      return;
    case 'link_down':
      requireLink(fault.linkId, 'linkId');
      checkPositive(fault.restoreAfter, `${path}.restoreAfter`, push, true);
      return;
    case 'partition':
      if (!Array.isArray(fault.groups) || fault.groups.length < 2) {
        push(`${path}.groups`, 'a partition needs at least two groups');
        return;
      }
      fault.groups.forEach((group, g) => {
        if (!Array.isArray(group) || group.length === 0) {
          push(`${path}.groups[${g}]`, 'must be a non-empty array of node ids');
          return;
        }
        group.forEach((id, n) => requireNode(id, `groups[${g}][${n}]`));
      });
      checkPositive(fault.healAfter, `${path}.healAfter`, push, true);
      return;
    case 'latency_spike':
      requireLink(fault.linkId, 'linkId');
      checkLatency(fault.latency, `${path}.latency`, push);
      if (fault.latency === undefined) push(`${path}.latency`, 'is required');
      checkPositive(fault.durationMs, `${path}.durationMs`, push, true);
      return;
    case 'packet_loss':
      requireLink(fault.linkId, 'linkId');
      checkProbability(fault.lossRate, `${path}.lossRate`, push);
      if (fault.lossRate === undefined) push(`${path}.lossRate`, 'is required');
      checkPositive(fault.durationMs, `${path}.durationMs`, push, true);
      return;
    default:
      push(`${path}.kind`, `unknown fault kind "${String((fault as { kind: string }).kind)}"`);
  }
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

type Push = (path: string, message: string) => void;

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

function checkLatency(value: LatencySpec | undefined, path: string, push: Push): void {
  if (value === undefined) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) push(path, 'latency must be a finite, non-negative number');
    return;
  }
  if (typeof value !== 'object' || value === null) {
    push(path, 'must be a number or latency distribution');
    return;
  }
  switch (value.kind) {
    case 'fixed':
      checkNonNegative(value.value, `${path}.value`, push);
      return;
    case 'uniform':
      checkNonNegative(value.min, `${path}.min`, push);
      checkNonNegative(value.max, `${path}.max`, push);
      if (typeof value.min === 'number' && typeof value.max === 'number' && value.min > value.max) {
        push(path, 'min must not exceed max');
      }
      return;
    case 'normal':
      checkNonNegative(value.mean, `${path}.mean`, push);
      checkNonNegative(value.stddev, `${path}.stddev`, push);
      return;
    case 'exponential':
      checkNonNegative(value.mean, `${path}.mean`, push);
      return;
    default:
      push(`${path}.kind`, `unknown latency kind "${String((value as { kind: string }).kind)}"`);
  }
}

function checkProbability(value: unknown, path: string, push: Push): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    push(path, 'must be a probability between 0 and 1');
  }
}

function checkNonNegative(value: unknown, path: string, push: Push): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    push(path, 'must be a finite, non-negative number');
  }
}

function checkPositive(value: unknown, path: string, push: Push, optional: boolean): void {
  if (value === undefined) {
    if (!optional) push(path, 'is required');
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    push(path, 'must be a finite number greater than 0');
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
