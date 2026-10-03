'use client';

import { useEffect, useState } from 'react';
import { SCENARIOS } from '@distlab/scenarios';
import type { SimulationSpec } from '@distlab/shared';
import { useLab } from '@/lib/store';
import { listDesigns, type SavedDesign } from '@/lib/persistence';

export type SpecSource = { kind: 'current' } | { kind: 'scenario'; id: string } | { kind: 'design'; id: string };

export function useSpecSource(source: SpecSource): SimulationSpec | undefined {
  const current = useLab((s) => s.spec);
  const [designs, setDesigns] = useState<SavedDesign[]>([]);
  useEffect(() => {
    void listDesigns().then(setDesigns);
  }, []);
  if (source.kind === 'current') return current;
  if (source.kind === 'scenario') return SCENARIOS.find((s) => s.spec.id === source.id)?.spec;
  return designs.find((d) => d.id === source.id)?.spec;
}

export function SpecPicker({ label, value, onChange }: { label: string; value: SpecSource; onChange(source: SpecSource): void }) {
  const [designs, setDesigns] = useState<SavedDesign[]>([]);
  useEffect(() => {
    void listDesigns().then(setDesigns);
  }, []);
  const encoded = value.kind === 'current' ? 'current' : `${value.kind}:${value.id}`;
  return (
    <div className="field">
      <label>{label}</label>
      <select
        className="select"
        value={encoded}
        onChange={(e) => {
          const [kind, ...rest] = e.target.value.split(':');
          const id = rest.join(':');
          onChange(kind === 'current' ? { kind: 'current' } : { kind: kind as 'scenario' | 'design', id });
        }}
      >
        <option value="current">Current design in the lab</option>
        <optgroup label="Library">
          {SCENARIOS.map((s) => (
            <option key={s.spec.id} value={`scenario:${s.spec.id}`}>
              {s.spec.name}
            </option>
          ))}
        </optgroup>
        {designs.length > 0 ? (
          <optgroup label="Saved designs">
            {designs.map((d) => (
              <option key={d.id} value={`design:${d.id}`}>
                {d.name}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </div>
  );
}
