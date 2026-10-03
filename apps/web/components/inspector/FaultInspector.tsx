'use client';

import type { FaultSpec, LatencySpec } from '@distlab/shared';
import { describeFault } from '@distlab/shared';
import { useLab } from '@/lib/store';
import { linkId } from '@/lib/spec-edit';
import { LatencyField, NodeRefField, NumberField, PercentField, SelectField } from '@/components/ui/fields';
import { Icon } from '@/components/ui/icons';
import { faultForm, type FaultField } from './fault-forms';
import { Header, Section } from './common';

export function FaultInspector({ id }: { id: string }) {
  const spec = useLab((s) => s.spec);
  const lab = useLab.getState();
  const faults = spec.faults ?? [];
  const fault = faults.find((f, i) => (f.id ?? `fault-${i + 1}`) === id);
  if (!fault) return <div className="empty">That fault no longer exists.</div>;
  const form = faultForm(fault.kind);
  const record = fault as unknown as Record<string, unknown>;
  const set = (patch: Record<string, unknown>) => lab.updateFault(id, patch);

  return (
    <>
      <Header
        icon={
          <span className="node-icon">
            <Icon name="bolt" size={15} />
          </span>
        }
        title={form?.label ?? fault.kind}
        subtitle={describeFault(fault)}
        onClose={() => lab.select(null)}
        actions={
          <button
            className="btn danger"
            onClick={() => {
              lab.removeFault(id);
              lab.select(null);
            }}
          >
            <Icon name="trash" size={13} /> Remove
          </button>
        }
      />
      <Section title="When">
        <NumberField label="At" hint="Virtual time the fault takes effect" value={fault.at} min={0} suffix="ms" onChange={(at) => at !== undefined && set({ at })} />
      </Section>
      <Section title="What">
        {form?.summary ? <div className="field-hint">{form.summary}</div> : null}
        {form?.fields.map((field) => (
          <FieldFor key={field.key} field={field} fault={fault} value={record[field.key]} set={set} />
        ))}
      </Section>
    </>
  );
}

function FieldFor({
  field,
  fault,
  value,
  set,
}: {
  field: FaultField;
  fault: FaultSpec;
  value: unknown;
  set(patch: Record<string, unknown>): void;
}) {
  const spec = useLab((s) => s.spec);
  switch (field.kind) {
    case 'node':
      return (
        <NodeRefField
          label={field.label}
          value={value as string | undefined}
          spec={spec}
          {...(field.types ? { types: field.types } : {})}
          onChange={(v) => v && set({ [field.key]: v })}
        />
      );
    case 'link':
      return (
        <SelectField
          label={field.label}
          value={(value as string) ?? ''}
          options={spec.links.map((l) => ({ value: linkId(l), label: linkId(l) }))}
          onChange={(v) => set({ [field.key]: v })}
        />
      );
    case 'ms':
      return (
        <NumberField
          label={field.label}
          {...(field.hint ? { hint: field.hint } : {})}
          value={value as number | undefined}
          min={1}
          suffix="ms"
          optional={field.optional ?? false}
          onChange={(v) => set({ [field.key]: v })}
        />
      );
    case 'percent':
      return <PercentField label={field.label} value={value as number | undefined} onChange={(v) => set({ [field.key]: v ?? 0 })} />;
    case 'factor':
      return <NumberField label={field.label} value={value as number | undefined} min={1} suffix="×" onChange={(v) => v && set({ [field.key]: v })} />;
    case 'latency':
      return <LatencyField label={field.label} value={value as LatencySpec | undefined} onChange={(v) => v !== undefined && set({ [field.key]: v })} />;
    case 'groups': {
      const groups = (fault as { groups?: readonly (readonly string[])[] }).groups ?? [[], []];
      const sideOf = (nodeId: string) => groups.findIndex((g) => g.includes(nodeId));
      const assign = (nodeId: string, side: number) => {
        const next = [0, 1].map((s) => (groups[s] ?? []).filter((n) => n !== nodeId));
        if (side >= 0) next[side] = [...(next[side] ?? []), nodeId];
        set({ groups: next });
      };
      return (
        <div className="field">
          <span className="field-label">{field.label}</span>
          <span className="field-hint">Nodes on different sides cannot reach each other; unassigned nodes are unaffected.</span>
          {spec.nodes.map((n) => (
            <div key={n.id} className="row">
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.label ?? n.id}</span>
              <div className="seg">
                {['A', 'B', '—'].map((label, side) => {
                  const target = side === 2 ? -1 : side;
                  return (
                    <button key={label} aria-pressed={sideOf(n.id) === target} onClick={() => assign(n.id, target)}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      );
    }
  }
}
