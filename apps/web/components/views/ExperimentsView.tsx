'use client';

import { useMemo, useState } from 'react';
import type { SimulationSpec } from '@distlab/shared';
import { applyExperiment, describeChange, type ExperimentChange } from '@distlab/scenarios';
import { useLab } from '@/lib/store';
import { runInBackground } from '@/lib/engine/batch';
import type { RunSummary } from '@/lib/engine/protocol';
import { NumberField, SelectField } from '@/components/ui/fields';
import { Icon } from '@/components/ui/icons';
import { RunComparison } from './RunResults';

type Preset = { label: string; question: string; changes: (spec: SimulationSpec) => ExperimentChange[] | undefined };

const first = (spec: SimulationSpec, ...types: string[]) => spec.nodes.find((n) => types.includes(n.type));
const all = (spec: SimulationSpec, type: string) => spec.nodes.filter((n) => n.type === type);

const PRESETS: readonly Preset[] = [
  { label: 'Traffic doubles', question: 'What happens if traffic doubles?', changes: () => [{ kind: 'scale_traffic', factor: 2 }] },
  {
    label: 'Database latency 2s',
    question: 'What happens if database latency becomes 2 seconds?',
    changes: (spec) => {
      const db = first(spec, 'database');
      return db
        ? [
            { kind: 'set_node', nodeId: db.id, field: 'readLatency', value: 2000 },
            { kind: 'set_node', nodeId: db.id, field: 'writeLatency', value: 2000 },
          ]
        : undefined;
    },
  },
  {
    label: 'A server fails',
    question: 'What happens if a server fails midway?',
    changes: (spec) => {
      const server = first(spec, 'api', 'service');
      return server ? [{ kind: 'add_fault', fault: { kind: 'node_crash', at: Math.round((spec.durationMs ?? 20_000) / 3), nodeId: server.id } }] : undefined;
    },
  },
  { label: 'Packet loss 20%', question: 'What happens if packet loss becomes 20%?', changes: () => [{ kind: 'set_all_links', field: 'lossRate', value: 0.2 }] },
  {
    label: 'Least connections',
    question: 'What happens if the balancer routes by least connections instead?',
    changes: (spec) => {
      const lb = first(spec, 'load_balancer', 'gateway');
      return lb ? [{ kind: 'set_node', nodeId: lb.id, field: 'routing', value: 'least_connections' }] : undefined;
    },
  },
  {
    label: 'Clients get a circuit breaker',
    question: 'What happens if the clients stop calling a dependency that keeps failing?',
    changes: (spec) => {
      const client = first(spec, 'client');
      return client
        ? [
            { kind: 'set_node', nodeId: client.id, field: 'circuitBreaker', value: { failureThreshold: 10, cooldownMs: 2000 } },
            { kind: 'set_node', nodeId: client.id, field: 'retry', value: { maxRetries: 2, backoff: 'exponential', baseDelayMs: 300, jitter: 'full' } },
          ]
        : undefined;
    },
  },
  {
    label: 'Read from the primary',
    question: 'What happens if every read goes to the primary?',
    changes: (spec) => {
      const readers = spec.nodes.filter((n) => n.config?.readPreference !== undefined || spec.links.some((l) => l.from === n.id && spec.nodes.find((t) => t.id === l.to)?.type === 'replica'));
      return readers.length > 0 ? readers.map((n) => ({ kind: 'set_node', nodeId: n.id, field: 'readPreference', value: 'primary' }) as ExperimentChange) : undefined;
    },
  },
  {
    label: 'Synchronous replication',
    question: 'What happens if writes wait for the replicas?',
    changes: (spec) => {
      const db = spec.nodes.find((n) => n.type === 'database' && spec.nodes.some((r) => r.config?.replicaOf === n.id));
      return db ? [{ kind: 'set_node', nodeId: db.id, field: 'replication', value: { mode: 'sync' } }] : undefined;
    },
  },
  {
    label: 'Idempotent writes',
    question: 'What happens if the database recognises repeated writes?',
    changes: (spec) => {
      const dbs = all(spec, 'database');
      return dbs.length > 0 ? dbs.map((db) => ({ kind: 'set_node', nodeId: db.id, field: 'idempotentWrites', value: true }) as ExperimentChange) : undefined;
    },
  },
  {
    label: 'Apply in log order',
    question: 'What happens if replicas apply records in log order?',
    changes: (spec) => {
      const replicas = all(spec, 'replica').filter((r) => r.config?.replicaApply === 'arrival');
      return replicas.length > 0 ? replicas.map((r) => ({ kind: 'set_node', nodeId: r.id, field: 'replicaApply', value: 'ordered' }) as ExperimentChange) : undefined;
    },
  },
  {
    label: 'Coalesce cache misses',
    question: 'What happens if concurrent misses share one fill?',
    changes: (spec) => {
      const caches = all(spec, 'cache');
      return caches.length > 0
        ? caches.map((c) => ({ kind: 'set_node', nodeId: c.id, field: 'cache', value: { ttlMs: 30_000, ...c.config?.cache, coalesce: true } }) as ExperimentChange)
        : undefined;
    },
  },
  {
    label: 'Fencing tokens',
    question: 'What happens if storage refuses writes with an old lock token?',
    changes: (spec) => {
      const storage = [...new Set(spec.nodes.map((n) => n.config?.lockClient?.storage).filter((id): id is string => id !== undefined))].filter(
        (id) => spec.nodes.find((n) => n.id === id)?.config?.fencing !== true,
      );
      return storage.length > 0 ? storage.map((id) => ({ kind: 'set_node', nodeId: id, field: 'fencing', value: true }) as ExperimentChange) : undefined;
    },
  },
  {
    label: 'Leader election: no randomness',
    question: 'What happens if every Raft node uses the same election timeout?',
    changes: (spec) => {
      const members = all(spec, 'consensus');
      return members.length > 1
        ? members.map(
            (n) =>
              ({ kind: 'set_node', nodeId: n.id, field: 'consensus', value: { ...n.config?.consensus, electionTimeoutMs: { min: 200, max: 200 } } }) as ExperimentChange,
          )
        : undefined;
    },
  },
  {
    label: 'Different luck',
    question: 'How much of the result is luck? Same configuration, different seed.',
    changes: () => [{ kind: 'set_seed', seed: 'what-if-reseed' }],
  },
];

/** "What if…?" — the current design as the baseline, the same design with changes as the variant. */
export function ExperimentsView() {
  const spec = useLab((s) => s.spec);
  const lab = useLab.getState();
  const [changes, setChanges] = useState<ExperimentChange[]>([]);
  const [name, setName] = useState('Variant');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ a: RunSummary; b: RunSummary } | null>(null);
  const [customField, setCustomField] = useState<'concurrency' | 'processing' | 'readLatency' | 'queueCapacity'>('concurrency');
  const [customNode, setCustomNode] = useState('');
  const [customValue, setCustomValue] = useState<number | undefined>(undefined);

  const applied = useMemo(() => applyExperiment(spec, { name, changes }), [spec, name, changes]);

  const run = async () => {
    if (!applied.ok) return;
    setRunning(true);
    try {
      const [a, b] = await Promise.all([runInBackground(spec), runInBackground(applied.variant)]);
      setResult({ a, b });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="view-inner" data-testid="experiments">
      <div>
        <h1 style={{ margin: 0, fontSize: 20 }}>What if…?</h1>
        <p className="prose" style={{ margin: '4px 0 0' }}>
          The current design is the baseline. Describe the variant as a list of changes; both run with the same seed and
          workload, so every difference you see is caused by the changes.
        </p>
      </div>
      <div className="card stack">
        <div className="panel-title" style={{ margin: 0 }}>
          Start from a question
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {PRESETS.map((preset) => {
            const preset_changes = preset.changes(spec);
            if (!preset_changes) return null;
            return (
              <button
                key={preset.label}
                className="btn"
                title={preset.question}
                onClick={() => {
                  setChanges(preset_changes ?? []);
                  setName(preset.label);
                  setResult(null);
                }}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <div className="panel-title" style={{ margin: '6px 0 0' }}>
          Changes
        </div>
        {changes.length === 0 ? <div className="muted">No changes yet — pick a question or add one below.</div> : null}
        {changes.map((change, index) => (
          <div key={index} className="row">
            <Icon name="flask" size={13} />
            <span className="mono" style={{ fontSize: 12 }}>
              {describeChange(change)}
            </span>
            <span className="spacer" />
            <button className="btn icon ghost" aria-label="Remove change" onClick={() => setChanges(changes.filter((_, i) => i !== index))}>
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
        <div className="row" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
          <div style={{ width: 160 }}>
            <SelectField
              label="Node"
              value={customNode}
              options={[{ value: '', label: 'Choose…' }, ...spec.nodes.filter((n) => n.type !== 'client').map((n) => ({ value: n.id, label: n.label ?? n.id }))]}
              onChange={setCustomNode}
            />
          </div>
          <div style={{ width: 170 }}>
            <SelectField
              label="Setting"
              value={customField}
              options={[
                { value: 'concurrency', label: 'Concurrency' },
                { value: 'queueCapacity', label: 'Queue capacity' },
                { value: 'processing', label: 'Processing (ms)' },
                { value: 'readLatency', label: 'Read latency (ms)' },
              ]}
              onChange={(v) => setCustomField(v as typeof customField)}
            />
          </div>
          <div style={{ width: 110 }}>
            <NumberField label="Value" value={customValue} min={0} optional onChange={setCustomValue} />
          </div>
          <button
            className="btn"
            disabled={!customNode || customValue === undefined}
            onClick={() => {
              setChanges([...changes, { kind: 'set_node', nodeId: customNode, field: customField, value: customValue }]);
              setResult(null);
            }}
          >
            <Icon name="plus" size={13} /> Add change
          </button>
        </div>
        {!applied.ok ? (
          <div className="callout">
            {applied.issues.slice(0, 3).map((i) => (
              <div key={i.path}>
                <code>{i.path}</code> {i.message}
              </div>
            ))}
          </div>
        ) : null}
        <div className="row">
          <button className="btn primary" onClick={run} disabled={running || changes.length === 0 || !applied.ok} data-testid="run-experiment">
            <Icon name="play" size={13} /> {running ? 'Running…' : 'Run baseline and variant'}
          </button>
          {applied.ok && changes.length > 0 ? (
            <button
              className="btn"
              onClick={() => {
                lab.loadSpec(applied.variant);
                lab.setView('lab');
              }}
            >
              Open variant in the lab
            </button>
          ) : null}
        </div>
      </div>
      {result ? (
        <RunComparison
          a={result.a.snapshot}
          b={result.b.snapshot}
          labelA="Baseline"
          labelB={name}
          durationMs={Math.max(spec.durationMs ?? 0, applied.ok ? applied.variant.durationMs ?? 0 : 0)}
        />
      ) : null}
    </div>
  );
}
