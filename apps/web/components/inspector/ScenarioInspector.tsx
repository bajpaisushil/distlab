'use client';

import { useState } from 'react';
import type { FaultKind } from '@distlab/shared';
import { useLab } from '@/lib/store';
import { linkId } from '@/lib/spec-edit';
import { NumberField, TextField } from '@/components/ui/fields';
import { Icon } from '@/components/ui/icons';
import { formatClock } from '@/lib/format';
import { FAULT_FORMS } from './fault-forms';
import { Header, Section } from './common';

export function ScenarioInspector() {
  const spec = useLab((s) => s.spec);
  const now = useLab((s) => s.frame?.now ?? 0);
  const lab = useLab.getState();
  const [faultKind, setFaultKind] = useState<FaultKind>('node_crash');

  const addFault = (at: number) => {
    const form = FAULT_FORMS.find((f) => f.kind === faultKind)!;
    const firstServer = spec.nodes.find((n) => n.type !== 'client')?.id;
    const firstLink = spec.links[0] ? linkId(spec.links[0]) : undefined;
    let fault = form.create(Math.round(at), firstServer, firstLink);
    if (!fault && faultKind === 'partition' && spec.nodes.length >= 2) {
      const half = Math.ceil(spec.nodes.length / 2);
      fault = {
        kind: 'partition',
        at: Math.round(at),
        groups: [spec.nodes.slice(0, half).map((n) => n.id), spec.nodes.slice(half).map((n) => n.id)],
        healAfter: 2000,
      };
    }
    if (!fault) return;
    const id = lab.addFault(fault);
    lab.select({ kind: 'fault', id });
  };

  return (
    <>
      <Header title={spec.name} subtitle="Scenario" />
      <Section title="Scenario">
        <TextField label="Name" value={spec.name} onChange={(name) => lab.updateScenario({ name })} />
        <div className="field">
          <label htmlFor="scenario-description">Description</label>
          <textarea
            id="scenario-description"
            className="textarea"
            defaultValue={spec.description ?? ''}
            key={spec.id}
            onBlur={(e) => e.target.value !== (spec.description ?? '') && lab.updateScenario({ description: e.target.value })}
          />
        </div>
        <div className="grid-2">
          <TextField
            label="Seed"
            value={String(spec.seed)}
            onChange={(seed) => lab.updateScenario({ seed })}
          />
          <NumberField
            label="Duration"
            value={spec.durationMs}
            min={100}
            suffix="ms"
            onChange={(durationMs) => durationMs && lab.updateScenario({ durationMs })}
          />
        </div>
        <div className="field-hint">
          The seed fixes every random draw: same seed, same scenario, same run — event for event.
        </div>
      </Section>

      {spec.learningObjectives && spec.learningObjectives.length > 0 ? (
        <Section title="What this shows">
          <ul className="prose" style={{ margin: 0, paddingLeft: 18 }}>
            {spec.learningObjectives.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
          {spec.observe && spec.observe.length > 0 ? (
            <div className="callout">
              <strong>Watch for:</strong> {spec.observe.join(' · ')}
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section title="Inject a fault">
        <div className="field">
          <label htmlFor="fault-kind">Kind</label>
          <select id="fault-kind" className="select" value={faultKind} onChange={(e) => setFaultKind(e.target.value as FaultKind)}>
            {FAULT_FORMS.map((f) => (
              <option key={f.kind} value={f.kind}>
                {f.label}
              </option>
            ))}
          </select>
          <span className="field-hint">{FAULT_FORMS.find((f) => f.kind === faultKind)?.summary}</span>
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => addFault(now)} data-testid="inject-now">
            <Icon name="bolt" size={13} /> Inject at {formatClock(now)}
          </button>
          <button className="btn" onClick={() => addFault(Math.min(spec.durationMs ?? 20000, now + 2000))}>
            Schedule +2s
          </button>
        </div>
        <div className="field-hint">
          Injected faults become part of the scenario, so the run stays replayable and exportable.
        </div>
      </Section>
    </>
  );
}
