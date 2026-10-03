'use client';

import type { NodeSpec, QueuePolicy } from '@distlab/shared';
import { useLab } from '@/lib/store';
import { NodeRefField, NumberField, PercentField, ToggleField } from '@/components/ui/fields';
import { Section } from '@/components/inspector/common';

export function QueueSection({ node }: { node: NodeSpec }) {
  const spec = useLab((s) => s.spec);
  const lab = useLab.getState();
  const config = node.config ?? {};
  const set = (patch: Record<string, unknown>) => lab.updateNode(node.id, { config: patch });

  if (node.type === 'worker') {
    return (
      <Section title="Consumer" open>
        <NumberField
          label="Prefetch"
          hint="Deliveries this worker may hold unacknowledged (default: its concurrency)"
          value={config.consumer?.prefetch}
          min={1}
          optional
          placeholder={String(config.concurrency ?? 4)}
          onChange={(prefetch) => set({ consumer: prefetch === undefined ? undefined : { prefetch: Math.round(prefetch) } })}
        />
      </Section>
    );
  }
  if (node.type !== 'queue') return null;

  const queue: QueuePolicy = config.queue ?? { capacity: 1000 };
  const setQueue = (patch: Partial<QueuePolicy>) => set({ queue: { ...queue, ...patch } });
  const workers = spec.links
    .filter((l) => l.from === node.id || l.to === node.id)
    .map((l) => (l.from === node.id ? l.to : l.from))
    .filter((id) => spec.nodes.find((n) => n.id === id)?.type === 'worker');

  return (
    <Section title="Queue" open>
      <div className="field-hint">
        {workers.length === 0 ? 'No workers are linked, so nothing consumes this queue.' : `Delivers to ${workers.join(', ')}.`}
      </div>
      <div className="grid-2">
        <NumberField label="Capacity" hint="Items held before refusing" value={queue.capacity} min={1} onChange={(capacity) => capacity && setQueue({ capacity: Math.round(capacity) })} />
        <NumberField label="Max deliveries" hint="Before dead-lettering" value={queue.maxDeliveries} min={1} optional placeholder="5" onChange={(maxDeliveries) => setQueue({ maxDeliveries })} />
      </div>
      <div className="grid-2">
        <NumberField label="Visibility timeout" hint="Unacked this long → redeliver" value={queue.visibilityTimeoutMs} min={1} optional suffix="ms" placeholder="1000" onChange={(visibilityTimeoutMs) => setQueue({ visibilityTimeoutMs })} />
        <NumberField label="Redelivery delay" value={queue.redeliveryDelayMs} min={0} optional suffix="ms" placeholder="0" onChange={(redeliveryDelayMs) => setQueue({ redeliveryDelayMs })} />
      </div>
      <NodeRefField
        label="Dead-letter queue"
        hint="Where items go after their last delivery fails (must be linked)"
        value={queue.deadLetterQueue}
        spec={spec}
        types={['queue']}
        exclude={node.id}
        allowNone
        onChange={(deadLetterQueue) => setQueue({ deadLetterQueue })}
      />
      <PercentField label="Poison messages" hint="Share of items that can never be processed" value={queue.poisonRate} onChange={(poisonRate) => setQueue({ poisonRate })} />
      <ToggleField label="Durable" hint="Items survive a crash" checked={queue.durable ?? true} onChange={(durable) => setQueue({ durable })} />
    </Section>
  );
}
