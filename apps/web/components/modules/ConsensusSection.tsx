'use client';

import { DEFAULT_CLUSTER_ID, DEFAULT_ELECTION_TIMEOUT, DEFAULT_HEARTBEAT_MS, type NodeSpec } from '@distlab/shared';
import { useLab } from '@/lib/store';
import { NumberField, TextField } from '@/components/ui/fields';
import { Section } from '@/components/inspector/common';

export function ConsensusSection({ node }: { node: NodeSpec }) {
  const spec = useLab((s) => s.spec);
  const lab = useLab.getState();
  if (node.type !== 'consensus') return null;
  const consensus = node.config?.consensus ?? {};
  const cluster = consensus.clusterId ?? DEFAULT_CLUSTER_ID;
  const members = spec.nodes.filter((n) => n.type === 'consensus' && (n.config?.consensus?.clusterId ?? DEFAULT_CLUSTER_ID) === cluster);
  const timeout = consensus.electionTimeoutMs ?? DEFAULT_ELECTION_TIMEOUT;
  const set = (patch: Record<string, unknown>) => lab.updateNode(node.id, { config: { consensus: { ...consensus, ...patch } } });

  return (
    <Section title="Raft (educational)" open>
      <div className="field-hint">
        A Raft-like cluster of {members.length} node{members.length === 1 ? '' : 's'} — needs {Math.floor(members.length / 2) + 1} votes to
        elect a leader. An educational simulation of the algorithm, not a production implementation.
      </div>
      <TextField label="Cluster" value={cluster} onChange={(clusterId) => set({ clusterId: clusterId || undefined })} />
      <div className="grid-2">
        <NumberField label="Election timeout min" value={timeout.min} min={1} suffix="ms" onChange={(min) => min && set({ electionTimeoutMs: { ...timeout, min } })} />
        <NumberField label="max" value={timeout.max} min={1} suffix="ms" onChange={(max) => max && set({ electionTimeoutMs: { ...timeout, max } })} />
      </div>
      <div className="field-hint">Randomness here is what breaks ties: set min = max and watch votes split forever.</div>
      <NumberField
        label="Heartbeat"
        hint="How often the leader asserts itself; must be well under the election timeout"
        value={consensus.heartbeatIntervalMs}
        min={1}
        optional
        suffix="ms"
        placeholder={String(DEFAULT_HEARTBEAT_MS)}
        onChange={(heartbeatIntervalMs) => set({ heartbeatIntervalMs })}
      />
    </Section>
  );
}
