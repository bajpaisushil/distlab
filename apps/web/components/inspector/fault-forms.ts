import type { FaultKind, FaultSpec, NodeType, SimulationSpec } from '@distlab/shared';

/**
 * How each fault kind is edited. Data-driven so a new fault kind needs a
 * descriptor here, not a new form component.
 */
export type FaultField =
  | { readonly key: string; readonly label: string; readonly kind: 'node'; readonly types?: readonly NodeType[] }
  | { readonly key: string; readonly label: string; readonly kind: 'link' }
  | { readonly key: string; readonly label: string; readonly kind: 'ms'; readonly optional?: boolean; readonly hint?: string }
  | { readonly key: string; readonly label: string; readonly kind: 'percent' }
  | { readonly key: string; readonly label: string; readonly kind: 'latency' }
  | { readonly key: string; readonly label: string; readonly kind: 'factor' }
  | { readonly key: string; readonly label: string; readonly kind: 'groups' };

export interface FaultForm {
  readonly kind: FaultKind;
  readonly label: string;
  readonly summary: string;
  readonly fields: readonly FaultField[];
  /** A sensible fault of this kind for the given scenario, at time `at`. */
  create(at: number, firstNode: string | undefined, firstLink: string | undefined, spec: SimulationSpec): FaultSpec | undefined;
}

/** The first node of one of `types`, in the order they appear in the scenario. */
function firstOf(spec: SimulationSpec, types: readonly NodeType[]): string | undefined {
  for (const type of types) {
    const node = spec.nodes.find((n) => n.type === type);
    if (node) return node.id;
  }
  return undefined;
}

export const FAULT_FORMS: readonly FaultForm[] = [
  {
    kind: 'node_crash',
    label: 'Node crash',
    summary: 'The process dies; work in memory is lost and nothing answers until it recovers.',
    fields: [
      { key: 'nodeId', label: 'Node', kind: 'node' },
      { key: 'recoverAfter', label: 'Recover after', kind: 'ms', optional: true, hint: 'Leave empty to stay down' },
    ],
    create: (at, node) => (node ? { kind: 'node_crash', at, nodeId: node, recoverAfter: 2000 } : undefined),
  },
  {
    kind: 'link_down',
    label: 'Link down',
    summary: 'A cable is cut. The sender can tell, so it fails fast.',
    fields: [
      { key: 'linkId', label: 'Link', kind: 'link' },
      { key: 'restoreAfter', label: 'Restore after', kind: 'ms', optional: true },
    ],
    create: (at, _node, link) => (link ? { kind: 'link_down', at, linkId: link, restoreAfter: 2000 } : undefined),
  },
  {
    kind: 'partition',
    label: 'Network partition',
    summary: 'The network splits. Packets across the split vanish silently.',
    fields: [
      { key: 'groups', label: 'Sides', kind: 'groups' },
      { key: 'healAfter', label: 'Heal after', kind: 'ms', optional: true },
    ],
    create: () => undefined,
  },
  {
    kind: 'latency_spike',
    label: 'Latency spike',
    summary: 'A link gets slow without going down — often worse than an outage.',
    fields: [
      { key: 'linkId', label: 'Link', kind: 'link' },
      { key: 'latency', label: 'Latency during spike', kind: 'latency' },
      { key: 'durationMs', label: 'Duration', kind: 'ms', optional: true },
    ],
    create: (at, _node, link) => (link ? { kind: 'latency_spike', at, linkId: link, latency: 500, durationMs: 3000 } : undefined),
  },
  {
    kind: 'packet_loss',
    label: 'Packet loss',
    summary: 'A link drops a fraction of everything it carries.',
    fields: [
      { key: 'linkId', label: 'Link', kind: 'link' },
      { key: 'lossRate', label: 'Loss', kind: 'percent' },
      { key: 'durationMs', label: 'Duration', kind: 'ms', optional: true },
    ],
    create: (at, _node, link) => (link ? { kind: 'packet_loss', at, linkId: link, lossRate: 0.2, durationMs: 3000 } : undefined),
  },
  {
    kind: 'packet_duplication',
    label: 'Packet duplication',
    summary: 'A link delivers some messages twice. Anything not idempotent now happens twice.',
    fields: [
      { key: 'linkId', label: 'Link', kind: 'link' },
      { key: 'duplicateRate', label: 'Duplicated', kind: 'percent' },
      { key: 'durationMs', label: 'Duration', kind: 'ms', optional: true },
    ],
    create: (at, _node, link) =>
      link ? { kind: 'packet_duplication', at, linkId: link, duplicateRate: 0.3, durationMs: 3000 } : undefined,
  },
  {
    kind: 'message_delay',
    label: 'Message delay',
    summary: 'Everything to and from one node is held up — a congested host rather than one slow link.',
    fields: [
      { key: 'nodeId', label: 'Node', kind: 'node' },
      { key: 'delay', label: 'Extra delay', kind: 'latency' },
      { key: 'durationMs', label: 'Duration', kind: 'ms', optional: true },
    ],
    create: (at, node) =>
      node ? { kind: 'message_delay', at, nodeId: node, delay: { kind: 'uniform', min: 100, max: 300 }, durationMs: 3000 } : undefined,
  },
  {
    kind: 'node_pause',
    label: 'Process pause',
    summary:
      'A stop-the-world freeze — a long GC, a stalled VM. The node keeps its state and wakes up believing no time has passed: leases it held may have expired.',
    fields: [
      { key: 'nodeId', label: 'Node', kind: 'node' },
      { key: 'durationMs', label: 'Frozen for', kind: 'ms' },
    ],
    create: (at, node) => (node ? { kind: 'node_pause', at, nodeId: node, durationMs: 1500 } : undefined),
  },
  {
    kind: 'node_slowdown',
    label: 'Overloaded node',
    summary: 'Every unit of work takes longer — a noisy neighbour, a hot CPU. Up, healthy-looking, and slow.',
    fields: [
      { key: 'nodeId', label: 'Node', kind: 'node' },
      { key: 'factor', label: 'Slower by', kind: 'factor' },
      { key: 'durationMs', label: 'Duration', kind: 'ms', optional: true },
    ],
    create: (at, node) => (node ? { kind: 'node_slowdown', at, nodeId: node, factor: 4, durationMs: 3000 } : undefined),
  },
  {
    kind: 'node_unavailable',
    label: 'Unavailable (refuses work)',
    summary: 'The process is up but rejects requests — a database out of connections, a queue refusing publishes. Fails fast.',
    fields: [
      { key: 'nodeId', label: 'Node', kind: 'node' },
      { key: 'durationMs', label: 'Duration', kind: 'ms', optional: true },
    ],
    create: (at, node, _link, spec) => {
      const target = firstOf(spec, ['database', 'queue', 'cache']) ?? node;
      return target ? { kind: 'node_unavailable', at, nodeId: target, durationMs: 2000 } : undefined;
    },
  },
  {
    kind: 'stale_replica',
    label: 'Stale replica',
    summary: 'A replica stops applying replication. It keeps answering reads — with older and older data — then catches up.',
    fields: [
      { key: 'nodeId', label: 'Replica', kind: 'node', types: ['replica'] },
      { key: 'durationMs', label: 'Duration', kind: 'ms', optional: true },
    ],
    create: (at, _node, _link, spec) => {
      const replica = firstOf(spec, ['replica']);
      return replica ? { kind: 'stale_replica', at, nodeId: replica, durationMs: 3000 } : undefined;
    },
  },
];

export function faultForm(kind: FaultKind): FaultForm | undefined {
  return FAULT_FORMS.find((f) => f.kind === kind);
}
