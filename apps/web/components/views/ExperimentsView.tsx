'use client';

import { useMemo, useState } from 'react';
import { applyExperiment, describeChange, type ExperimentChange } from '@distlab/scenarios';
import { useLab } from '@/lib/store';
import { runInBackground } from '@/lib/engine/batch';
import type { RunSummary } from '@/lib/engine/protocol';
import { NumberField, SelectField } from '@/components/ui/fields';
import { Icon } from '@/components/ui/icons';
import { RunComparison } from './RunResults';

type Preset = { label: string; question: string; changes: (ctx: PresetContext) => ExperimentChange[] | undefined };
type PresetContext = { db?: string; firstApi?: string; balancer?: string; duration: number };

const PRESETS: readonly Preset[] = [
  { label: 'Traffic doubles', question: 'What happens if traffic doubles?', changes: () => [{ kind: 'scale_traffic', factor: 2 }] },
  {
    label: 'Database latency 2s',
    question: 'What happens if database latency becomes 2 seconds?',
    changes: ({ db }) => (db ? [{ kind: 'set_node', nodeId: db, field: 'readLatency', value: 2000 }, { kind: 'set_node', nodeId: db, field: 'writeLatency', value: 2000 }] : undefined),
  },
  {
    label: 'A server fails',
    question: 'What happens if a server fails midway?',
    changes: ({ firstApi, duration }) =>
      firstApi ? [{ kind: 'add_fault', fault: { kind: 'node_crash', at: Math.round(duration / 3), nodeId: firstApi } }] : undefined,
  },
  { label: 'Packet loss 20%', question: 'What happens if packet loss becomes 20%?', changes: () => [{ kind: 'set_all_links', field: 'lossRate', value: 0.2 }] },
  {
    label: 'Least connections',
    question: 'What happens if the balancer routes by least connections instead?',
    changes: ({ balancer }) => (balancer ? [{ kind: 'set_node', nodeId: balancer, field: 'routing', value: 'least_connections' }] : undefined),
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

  const ctx: PresetContext = {
    ...(spec.nodes.find((n) => n.type === 'load_balancer' || n.type === 'gateway')
      ? { balancer: spec.nodes.find((n) => n.type === 'load_balancer' || n.type === 'gateway')!.id }
      : {}),
    ...(spec.nodes.find((n) => n.type === 'database') ? { db: spec.nodes.find((n) => n.type === 'database')!.id } : {}),
    ...(spec.nodes.find((n) => n.type === 'api' || n.type === 'service')
      ? { firstApi: spec.nodes.find((n) => n.type === 'api' || n.type === 'service')!.id }
      : {}),
    duration: spec.durationMs ?? 20_000,
  };

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
            const preset_changes = preset.changes(ctx);
            return (
              <button
                key={preset.label}
                className="btn"
                disabled={!preset_changes}
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
