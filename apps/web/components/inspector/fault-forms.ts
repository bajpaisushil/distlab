import type { FaultKind, FaultSpec, NodeType } from '@distlab/shared';

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
  create(at: number, firstNode: string | undefined, firstLink: string | undefined): FaultSpec | undefined;
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
];

export function faultForm(kind: FaultKind): FaultForm | undefined {
  return FAULT_FORMS.find((f) => f.kind === kind);
}
