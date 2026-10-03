import {
  validateSimulationSpec,
  linkIdFor,
  type FaultSpec,
  type LatencySpec,
  type LinkId,
  type NodeId,
  type SimulationSpec,
  type SpecIssue,
} from '@distlab/shared';

/**
 * One change to a baseline. Structured rather than free-form so that anything
 * proposing an experiment — the UI, a saved preset, an AI assistant — goes
 * through the same validation before the engine ever sees it.
 */
export type ExperimentChange =
  /** Multiply every workload's arrival rate (or burst size). "What if traffic doubles?" */
  | { readonly kind: 'scale_traffic'; readonly factor: number }
  /** Set one configuration field on one node. */
  | { readonly kind: 'set_node'; readonly nodeId: NodeId; readonly field: string; readonly value: unknown }
  /** Set one field on one link. */
  | { readonly kind: 'set_link'; readonly linkId: LinkId; readonly field: string; readonly value: unknown }
  /** Set the same field on every link. "What if packet loss becomes 20%?" */
  | { readonly kind: 'set_all_links'; readonly field: string; readonly value: unknown }
  | { readonly kind: 'add_fault'; readonly fault: FaultSpec }
  | { readonly kind: 'remove_faults' }
  | { readonly kind: 'set_seed'; readonly seed: string }
  | { readonly kind: 'set_duration'; readonly durationMs: number };

export interface Experiment {
  readonly name: string;
  readonly question?: string;
  readonly changes: readonly ExperimentChange[];
}

export type ExperimentResult =
  | { readonly ok: true; readonly variant: SimulationSpec }
  | { readonly ok: false; readonly issues: readonly SpecIssue[] };

const NODE_FIELDS = new Set([
  'processing',
  'concurrency',
  'queueCapacity',
  'failureProbability',
  'readLatency',
  'writeLatency',
  // load balancing
  'routing',
  'weight',
  'ewmaAlpha',
  'ewmaTtlMs',
  'virtualNodes',
  // reliability
  'callTimeoutMs',
  'retry',
  'circuitBreaker',
  'bulkheads',
]);

const LINK_FIELDS = new Set([
  'latency',
  'lossRate',
  'duplicateRate',
  'reorderRate',
  'reorderDelay',
  'bandwidthBytesPerSec',
  'enabled',
]);

/** Extra fields subsystems allow experiments to touch, registered as they are built. */
const extraNodeFields = new Set<string>();

export function allowNodeField(field: string): void {
  extraNodeFields.add(field);
}

export function isExperimentNodeField(field: string): boolean {
  return NODE_FIELDS.has(field) || extraNodeFields.has(field);
}

/**
 * Applies changes to a copy of the baseline and validates the result. The
 * baseline is never modified, and the variant keeps the baseline's seed unless
 * a change says otherwise — so any difference in the results comes from the
 * changes, not from different luck.
 */
export function applyExperiment(baseline: SimulationSpec, experiment: Experiment): ExperimentResult {
  const issues: SpecIssue[] = [];
  let spec: SimulationSpec = structuredClone(baseline);
  spec = { ...spec, id: `${baseline.id}--${slug(experiment.name)}`, name: `${baseline.name} — ${experiment.name}` };

  experiment.changes.forEach((change, index) => {
    const path = `changes[${index}]`;
    switch (change.kind) {
      case 'scale_traffic': {
        if (!(change.factor > 0) || !Number.isFinite(change.factor)) {
          issues.push({ path: `${path}.factor`, message: 'must be a positive number' });
          return;
        }
        spec = {
          ...spec,
          workloads: spec.workloads.map((w) => {
            const a = w.arrival;
            switch (a.kind) {
              case 'constant':
              case 'poisson':
                return { ...w, arrival: { ...a, ratePerSec: a.ratePerSec * change.factor } };
              case 'burst':
              case 'once':
                return { ...w, arrival: { ...a, count: Math.max(1, Math.round(a.count * change.factor)) } };
            }
          }),
        };
        return;
      }
      case 'set_node': {
        if (!spec.nodes.some((n) => n.id === change.nodeId)) {
          issues.push({ path: `${path}.nodeId`, message: `unknown node "${change.nodeId}"` });
          return;
        }
        if (!isExperimentNodeField(change.field)) {
          issues.push({ path: `${path}.field`, message: `"${change.field}" cannot be changed by an experiment` });
          return;
        }
        spec = {
          ...spec,
          nodes: spec.nodes.map((n) =>
            n.id === change.nodeId ? { ...n, config: { ...n.config, [change.field]: change.value } } : n,
          ),
        };
        return;
      }
      case 'set_link':
      case 'set_all_links': {
        if (!LINK_FIELDS.has(change.field)) {
          issues.push({ path: `${path}.field`, message: `"${change.field}" is not a link setting` });
          return;
        }
        if (change.kind === 'set_link' && !spec.links.some((l) => (l.id ?? linkIdFor(l.from, l.to)) === change.linkId)) {
          issues.push({ path: `${path}.linkId`, message: `unknown link "${change.linkId}"` });
          return;
        }
        spec = {
          ...spec,
          links: spec.links.map((l) =>
            change.kind === 'set_all_links' || (l.id ?? linkIdFor(l.from, l.to)) === change.linkId
              ? { ...l, [change.field]: change.value }
              : l,
          ),
        };
        return;
      }
      case 'add_fault':
        spec = { ...spec, faults: [...(spec.faults ?? []), change.fault] };
        return;
      case 'remove_faults':
        spec = { ...spec, faults: [] };
        return;
      case 'set_seed':
        spec = { ...spec, seed: change.seed };
        return;
      case 'set_duration':
        if (!(change.durationMs > 0)) {
          issues.push({ path: `${path}.durationMs`, message: 'must be greater than 0' });
          return;
        }
        spec = { ...spec, durationMs: change.durationMs };
        return;
      default:
        issues.push({ path: `${path}.kind`, message: `unknown change "${String((change as { kind: unknown }).kind)}"` });
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  const validation = validateSimulationSpec(spec);
  if (!validation.valid) return { ok: false, issues: validation.errors.map((e) => ({ ...e, path: `variant.${e.path}` })) };
  return { ok: true, variant: spec };
}

/** Human-readable one-liner for a change. */
export function describeChange(change: ExperimentChange): string {
  switch (change.kind) {
    case 'scale_traffic':
      return `traffic × ${change.factor}`;
    case 'set_node':
      return `${change.nodeId}.${change.field} = ${show(change.value)}`;
    case 'set_link':
      return `${change.linkId}.${change.field} = ${show(change.value)}`;
    case 'set_all_links':
      return `every link's ${change.field} = ${show(change.value)}`;
    case 'add_fault':
      return `add ${change.fault.kind.replace(/_/g, ' ')} at ${(change.fault.at / 1000).toFixed(1)}s`;
    case 'remove_faults':
      return 'remove all scheduled faults';
    case 'set_seed':
      return `seed = "${change.seed}"`;
    case 'set_duration':
      return `duration = ${change.durationMs}ms`;
  }
}

function show(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `"${value}"`;
  return JSON.stringify(value as LatencySpec);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'variant';
}
