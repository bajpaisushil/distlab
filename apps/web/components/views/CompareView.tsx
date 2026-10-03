'use client';

import { useState } from 'react';
import { validateSimulationSpec, type SimulationSpec } from '@distlab/shared';
import { runInBackground } from '@/lib/engine/batch';
import type { RunSummary } from '@/lib/engine/protocol';
import { ToggleField } from '@/components/ui/fields';
import { Icon } from '@/components/ui/icons';
import { RunComparison } from './RunResults';
import { SpecPicker, useSpecSource, type SpecSource } from './SpecPicker';

/** Gives architecture B the same traffic as A, so the comparison is about architecture alone. */
function withSameWorkload(a: SimulationSpec, b: SimulationSpec): SimulationSpec {
  return { ...b, workloads: structuredClone(a.workloads), seed: a.seed, durationMs: a.durationMs, faults: b.faults ?? [] };
}

export function CompareView() {
  const [sourceA, setSourceA] = useState<SpecSource>({ kind: 'current' });
  const [sourceB, setSourceB] = useState<SpecSource>({ kind: 'scenario', id: 'web-service' });
  const [sameWorkload, setSameWorkload] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ a: RunSummary; b: RunSummary; labelA: string; labelB: string; durationMs: number } | null>(null);
  const specA = useSpecSource(sourceA);
  const specB = useSpecSource(sourceB);

  const run = async () => {
    if (!specA || !specB) return;
    const b = sameWorkload ? withSameWorkload(specA, specB) : specB;
    const validation = validateSimulationSpec(b);
    if (!validation.valid) {
      setError(
        sameWorkload
          ? `B cannot run A's workload: ${validation.errors[0]?.path} ${validation.errors[0]?.message}. Give B a client with the same id as A's, or turn off "same workload".`
          : `B is invalid: ${validation.errors[0]?.path} ${validation.errors[0]?.message}`,
      );
      return;
    }
    setError(null);
    setRunning(true);
    try {
      const [ra, rb] = await Promise.all([runInBackground(specA), runInBackground(b)]);
      setResult({ a: ra, b: rb, labelA: `A · ${specA.name}`, labelB: `B · ${specB.name}`, durationMs: Math.max(specA.durationMs ?? 0, b.durationMs ?? 0) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="view-inner" data-testid="compare">
      <div>
        <h1 style={{ margin: 0, fontSize: 20 }}>Compare architectures</h1>
        <p className="prose" style={{ margin: '4px 0 0' }}>
          Run the same workload against two designs and see what changes. Both runs use the same seed, so the traffic is
          identical request for request.
        </p>
      </div>
      <div className="card stack">
        <div className="grid-2">
          <SpecPicker label="Architecture A" value={sourceA} onChange={setSourceA} />
          <SpecPicker label="Architecture B" value={sourceB} onChange={setSourceB} />
        </div>
        <ToggleField
          label="Give B exactly A's workload, seed and duration"
          hint="Needs B to have client nodes with the same ids as A's."
          checked={sameWorkload}
          onChange={setSameWorkload}
        />
        <div className="row">
          <button className="btn primary" onClick={run} disabled={running || !specA || !specB}>
            <Icon name="play" size={13} /> {running ? 'Running both…' : 'Run both'}
          </button>
          {result ? (
            <span className="muted num">
              A: {result.a.events.toLocaleString()} events in {result.a.wallMs.toFixed(0)}ms · B: {result.b.events.toLocaleString()} events in{' '}
              {result.b.wallMs.toFixed(0)}ms
            </span>
          ) : null}
        </div>
        {error ? <div className="callout">{error}</div> : null}
      </div>
      {result ? (
        <RunComparison a={result.a.snapshot} b={result.b.snapshot} labelA={result.labelA} labelB={result.labelB} durationMs={result.durationMs} />
      ) : null}
    </div>
  );
}
