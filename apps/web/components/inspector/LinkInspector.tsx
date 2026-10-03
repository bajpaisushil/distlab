'use client';

import type { LinkId } from '@distlab/shared';
import { useLab } from '@/lib/store';
import { linkId } from '@/lib/spec-edit';
import { LatencyField, NumberField, PercentField, ToggleField } from '@/components/ui/fields';
import { Icon } from '@/components/ui/icons';
import { formatMs, formatPercent } from '@/lib/format';
import { Header, KV, Section } from './common';

export function LinkInspector({ id }: { id: LinkId }) {
  const spec = useLab((s) => s.spec);
  const live = useLab((s) => s.frame?.links.find((l) => l.id === id));
  const now = useLab((s) => s.frame?.now ?? 0);
  const lab = useLab.getState();
  const link = spec.links.find((l) => linkId(l) === id);
  if (!link) return <div className="empty">That link no longer exists.</div>;
  const name = (nodeId: string) => spec.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const set = (patch: Record<string, unknown>) => lab.updateLink(id, patch);

  return (
    <>
      <Header
        icon={
          <span className="node-icon">
            <Icon name="link" size={15} />
          </span>
        }
        title={`${name(link.from)} → ${name(link.to)}`}
        subtitle={<span className="mono">{id}</span>}
        onClose={() => lab.select(null)}
        actions={
          <>
            <button
              className="btn"
              onClick={() => lab.select({ kind: 'fault', id: lab.addFault({ kind: 'link_down', at: Math.round(now), linkId: id, restoreAfter: 2000 }) })}
            >
              <Icon name="bolt" size={13} /> Cut now
            </button>
            <button
              className="btn"
              onClick={() =>
                lab.select({
                  kind: 'fault',
                  id: lab.addFault({ kind: 'latency_spike', at: Math.round(now), linkId: id, latency: 400, durationMs: 3000 }),
                })
              }
            >
              Spike now
            </button>
            <button className="btn danger" onClick={() => lab.removeLink(id)}>
              <Icon name="trash" size={13} /> Delete
            </button>
          </>
        }
      />
      <Section title="Live state">
        <KV
          rows={[
            ['State', live ? (live.enabled ? 'up' : 'down') : '—'],
            ['Mean latency', formatMs(live?.meanLatency)],
            ['Loss', formatPercent(live?.lossRate ?? 0)],
            ['Duplication', formatPercent(live?.duplicateRate ?? 0)],
          ]}
        />
      </Section>
      <Section title="Network behaviour">
        <LatencyField label="Latency" value={link.latency ?? 5} onChange={(latency) => set({ latency })} />
        <div className="grid-2">
          <PercentField label="Packet loss" value={link.lossRate} onChange={(lossRate) => set({ lossRate })} />
          <PercentField label="Duplication" value={link.duplicateRate} onChange={(duplicateRate) => set({ duplicateRate })} />
        </div>
        <div className="grid-2">
          <PercentField label="Reordering" hint="Messages delayed past later ones" value={link.reorderRate} onChange={(reorderRate) => set({ reorderRate })} />
          <NumberField
            label="Reorder delay"
            value={typeof link.reorderDelay === 'number' ? link.reorderDelay : undefined}
            optional
            min={0}
            suffix="ms"
            placeholder="20"
            onChange={(reorderDelay) => set({ reorderDelay })}
          />
        </div>
        <NumberField
          label="Bandwidth"
          hint="0 or empty means unlimited; otherwise messages queue on the wire"
          value={link.bandwidthBytesPerSec}
          optional
          min={0}
          suffix="B/s"
          onChange={(bandwidthBytesPerSec) => set({ bandwidthBytesPerSec })}
        />
        <ToggleField
          label="Bidirectional"
          hint="Responses travel back over the same link"
          checked={link.bidirectional ?? true}
          onChange={(bidirectional) => set({ bidirectional })}
        />
        <ToggleField label="Enabled" checked={link.enabled ?? true} onChange={(enabled) => set({ enabled })} />
      </Section>
    </>
  );
}
