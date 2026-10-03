'use client';

import { useEffect, useId, useState } from 'react';
import type { LatencySpec, NodeId, NodeType, SimulationSpec } from '@distlab/shared';

interface BaseProps {
  label: string;
  hint?: string;
}

/**
 * Number input that only commits on blur or Enter, so typing "250" does not
 * rebuild the simulation for "2" and "25" on the way.
 */
export function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  optional,
  placeholder,
}: BaseProps & {
  value: number | undefined;
  onChange(value: number | undefined): void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  optional?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);

  const parsed = draft.trim() === '' ? undefined : Number(draft);
  const invalid =
    (parsed === undefined && !optional) ||
    (parsed !== undefined &&
      (!Number.isFinite(parsed) || (min !== undefined && parsed < min) || (max !== undefined && parsed > max)));

  const commit = () => {
    if (invalid) {
      setDraft(value === undefined ? '' : String(value));
      return;
    }
    if (parsed !== value) onChange(parsed);
  };

  const input = (
    <input
      id={id}
      className={`input num${invalid ? ' invalid' : ''}`}
      inputMode="decimal"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value === undefined ? '' : String(value));
      }}
      aria-invalid={invalid}
      data-step={step}
    />
  );

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {suffix ? (
        <div className="input-group">
          {input}
          <span className="input-suffix">{suffix}</span>
        </div>
      ) : (
        input
      )}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

/** A probability edited as a percentage. */
export function PercentField({
  label,
  hint,
  value,
  onChange,
}: BaseProps & { value: number | undefined; onChange(value: number | undefined): void }) {
  return (
    <NumberField
      label={label}
      hint={hint}
      value={value === undefined ? undefined : round(value * 100)}
      onChange={(v) => onChange(v === undefined ? undefined : v / 100)}
      min={0}
      max={100}
      suffix="%"
      optional
      placeholder="0"
    />
  );
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: BaseProps & { value: string; onChange(value: string): void; placeholder?: string }) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onChange(draft)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: BaseProps & {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: BaseProps & { checked: boolean; onChange(checked: boolean): void }) {
  return (
    <div className="field">
      <label className="toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export function NodeRefField({
  label,
  hint,
  value,
  spec,
  types,
  exclude,
  onChange,
  allowNone,
}: BaseProps & {
  value: NodeId | undefined;
  spec: SimulationSpec;
  types?: readonly NodeType[];
  exclude?: NodeId;
  allowNone?: boolean;
  onChange(value: NodeId | undefined): void;
}) {
  const candidates = spec.nodes.filter((n) => (!types || types.includes(n.type)) && n.id !== exclude);
  return (
    <SelectField
      label={label}
      hint={hint}
      value={value ?? ''}
      options={[
        ...(allowNone || value === undefined ? [{ value: '', label: '— none —' }] : []),
        ...candidates.map((n) => ({ value: n.id, label: n.label ?? n.id })),
      ]}
      onChange={(v) => onChange(v === '' ? undefined : v)}
    />
  );
}

type LatencyKind = 'fixed' | 'uniform' | 'normal' | 'exponential';

/** Edits any latency distribution; a bare number is shown as "fixed". */
export function LatencyField({
  label,
  hint,
  value,
  onChange,
}: BaseProps & { value: LatencySpec | undefined; onChange(value: LatencySpec | undefined): void }) {
  const spec = value === undefined ? undefined : typeof value === 'number' ? { kind: 'fixed' as const, value } : value;
  const kind: LatencyKind = spec?.kind ?? 'fixed';

  const setKind = (next: LatencyKind) => {
    const center =
      spec === undefined
        ? 10
        : spec.kind === 'fixed'
          ? spec.value
          : spec.kind === 'uniform'
            ? (spec.min + spec.max) / 2
            : spec.mean;
    switch (next) {
      case 'fixed':
        return onChange(center);
      case 'uniform':
        return onChange({ kind: 'uniform', min: Math.max(0, center * 0.5), max: center * 1.5 });
      case 'normal':
        return onChange({ kind: 'normal', mean: center, stddev: Math.max(1, center * 0.25) });
      case 'exponential':
        return onChange({ kind: 'exponential', mean: center });
    }
  };

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="row" style={{ gap: 6, alignItems: 'end' }}>
        <select
          className="select"
          style={{ width: 104, flex: 'none' }}
          value={kind}
          aria-label={`${label} distribution`}
          onChange={(e) => setKind(e.target.value as LatencyKind)}
        >
          <option value="fixed">Fixed</option>
          <option value="uniform">Uniform</option>
          <option value="normal">Normal</option>
          <option value="exponential">Exponential</option>
        </select>
        <div style={{ flex: 1, minWidth: 0 }} className={kind === 'fixed' || kind === 'exponential' ? '' : 'grid-2'}>
          {spec?.kind === 'uniform' ? (
            <>
              <NumberField label="min" value={spec.min} min={0} suffix="ms" onChange={(v) => onChange({ ...spec, min: v ?? 0 })} />
              <NumberField label="max" value={spec.max} min={0} suffix="ms" onChange={(v) => onChange({ ...spec, max: v ?? 0 })} />
            </>
          ) : spec?.kind === 'normal' ? (
            <>
              <NumberField label="mean" value={spec.mean} min={0} suffix="ms" onChange={(v) => onChange({ ...spec, mean: v ?? 0 })} />
              <NumberField label="σ" value={spec.stddev} min={0} suffix="ms" onChange={(v) => onChange({ ...spec, stddev: v ?? 0 })} />
            </>
          ) : spec?.kind === 'exponential' ? (
            <NumberField label="mean" value={spec.mean} min={0} suffix="ms" onChange={(v) => onChange({ kind: 'exponential', mean: v ?? 0 })} />
          ) : (
            <NumberField
              label="value"
              value={spec?.kind === 'fixed' ? spec.value : undefined}
              min={0}
              suffix="ms"
              optional
              onChange={(v) => onChange(v)}
            />
          )}
        </div>
      </div>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}
