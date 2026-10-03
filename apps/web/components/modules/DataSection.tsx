'use client';

import {
  READ_PREFERENCES,
  REPLICA_APPLY_MODES,
  type CachePolicy,
  type NodeSpec,
  type ReplicationPolicy,
} from '@distlab/shared';
import { useLab } from '@/lib/store';
import { LatencyField, NodeRefField, NumberField, SelectField, ToggleField } from '@/components/ui/fields';
import { Section } from '@/components/inspector/common';

const READ_HINT: Record<string, string> = {
  primary: 'Always read the primary: never stale, but every read lands on one node',
  replica: 'Read replicas (falling back to the primary): spreads load, may return stale data',
  any: 'Balance reads over the primary and replicas alike',
};

export function DataSection({ node }: { node: NodeSpec }) {
  const spec = useLab((s) => s.spec);
  const lab = useLab.getState();
  const config = node.config ?? {};
  const set = (patch: Record<string, unknown>) => lab.updateNode(node.id, { config: patch });

  const targets = spec.links.filter((l) => l.from === node.id).map((l) => spec.nodes.find((n) => n.id === l.to));
  const readsStorage = targets.some((t) => t?.type === 'database' || t?.type === 'replica');
  const replicas = spec.nodes.filter((n) => n.type === 'replica' && n.config?.replicaOf === node.id);

  if (node.type === 'database') {
    const replication: ReplicationPolicy = config.replication ?? { mode: 'async' };
    return (
      <Section title="Replication" open>
        <div className="field-hint">
          {replicas.length === 0
            ? 'No replicas copy this database yet. Add a replica node; it attaches to the first database automatically.'
            : `Replicated to ${replicas.map((r) => r.label ?? r.id).join(', ')}.`}
        </div>
        <SelectField
          label="Mode"
          hint={
            replication.mode === 'sync'
              ? 'A write is acknowledged only once replicas have it: slower writes, no lost acknowledged writes'
              : 'A write is acknowledged at once and copied in the background: fast, replicas lag'
          }
          value={replication.mode}
          options={[
            { value: 'async', label: 'Asynchronous' },
            { value: 'sync', label: 'Synchronous' },
          ]}
          onChange={(mode) => set({ replication: { ...replication, mode } })}
        />
        {replication.mode === 'sync' ? (
          <NumberField
            label="Wait for"
            hint="Replica acknowledgements per write"
            value={replication.syncReplicas}
            min={1}
            optional
            placeholder={`all (${replicas.length})`}
            suffix="replicas"
            onChange={(syncReplicas) => set({ replication: { ...replication, syncReplicas } })}
          />
        ) : null}
        <ToggleField
          label="Idempotent writes"
          hint="Recognise a repeated write by its request id and apply it once"
          checked={config.idempotentWrites ?? false}
          onChange={(idempotentWrites) => set({ idempotentWrites })}
        />
      </Section>
    );
  }

  if (node.type === 'replica') {
    return (
      <Section title="Replica" open>
        <NodeRefField
          label="Copies primary"
          value={config.replicaOf}
          spec={spec}
          types={['database']}
          allowNone
          onChange={(replicaOf) => set({ replicaOf })}
        />
        <LatencyField
          label="Apply delay"
          hint="Time to apply a record after it arrives — on top of link latency"
          value={config.replicationDelay ?? 0}
          onChange={(replicationDelay) => set({ replicationDelay })}
        />
        <SelectField
          label="Apply order"
          hint={
            (config.replicaApply ?? 'ordered') === 'ordered'
              ? 'Strict log order, buffering gaps — converges whatever the network does'
              : 'Whatever arrives, when it arrives — reordering can roll keys back'
          }
          value={config.replicaApply ?? 'ordered'}
          options={REPLICA_APPLY_MODES.map((m) => ({ value: m, label: m === 'ordered' ? 'Log order' : 'Arrival order (naive)' }))}
          onChange={(replicaApply) => set({ replicaApply })}
        />
      </Section>
    );
  }

  if (node.type === 'cache') {
    const cache: CachePolicy = config.cache ?? { ttlMs: 30_000 };
    const setCache = (patch: Partial<CachePolicy>) => set({ cache: { ...cache, ...patch } });
    return (
      <Section title="Cache" open>
        <div className="grid-2">
          <NumberField label="TTL" value={cache.ttlMs} min={1} suffix="ms" onChange={(ttlMs) => ttlMs && setCache({ ttlMs })} />
          <NumberField label="Capacity" value={cache.capacity} min={1} optional placeholder="1000" suffix="keys" onChange={(capacity) => setCache({ capacity })} />
        </div>
        <ToggleField
          label="Coalesce misses"
          hint="Concurrent misses for one key share a single fill instead of all hitting the database"
          checked={cache.coalesce ?? false}
          onChange={(coalesce) => setCache({ coalesce })}
        />
      </Section>
    );
  }

  if (readsStorage) {
    return (
      <Section title="Reads" open={targets.some((t) => t?.type === 'replica')}>
        <SelectField
          label="Read preference"
          hint={READ_HINT[config.readPreference ?? 'any']}
          value={config.readPreference ?? 'any'}
          options={READ_PREFERENCES.map((p) => ({ value: p, label: p }))}
          onChange={(readPreference) => set({ readPreference })}
        />
      </Section>
    );
  }
  return null;
}
