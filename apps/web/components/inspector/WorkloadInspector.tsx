'use client';

import type { ArrivalSpec, WorkloadSpec } from '@distlab/shared';
import { useLab } from '@/lib/store';
import { NodeRefField, NumberField, PercentField, SelectField } from '@/components/ui/fields';
import { Icon } from '@/components/ui/icons';
import { Header, Section } from './common';

const OPERATIONS = ['HTTP_GET', 'HTTP_POST', 'DB_READ', 'DB_WRITE', 'RPC', 'ENQUEUE'] as const;

function defaultArrival(kind: ArrivalSpec['kind']): ArrivalSpec {
  switch (kind) {
    case 'once':
      return { kind: 'once', count: 10 };
    case 'constant':
      return { kind: 'constant', ratePerSec: 50 };
    case 'poisson':
      return { kind: 'poisson', ratePerSec: 50 };
    case 'burst':
      return { kind: 'burst', count: 20, everyMs: 1000 };
  }
}

export function WorkloadInspector({ id }: { id: string }) {
  const spec = useLab((s) => s.spec);
  const lab = useLab.getState();
  const workload = spec.workloads.find((w) => w.id === id);
  if (!workload) return <div className="empty">That workload no longer exists.</div>;
  const set = (patch: Partial<WorkloadSpec>) => lab.updateWorkload(id, patch);
  const arrival = workload.arrival;
  const mix = workload.mix ?? [];

  return (
    <>
      <Header
        icon={
          <span className="node-icon">
            <Icon name="activity" size={15} />
          </span>
        }
        title={workload.id}
        subtitle="Workload"
        onClose={() => lab.select(null)}
        actions={
          <button
            className="btn danger"
            onClick={() => {
              lab.removeWorkload(id);
              lab.select(null);
            }}
          >
            <Icon name="trash" size={13} /> Delete
          </button>
        }
      />
      <Section title="Traffic">
        <NodeRefField label="Client" value={workload.clientId} spec={spec} types={['client']} onChange={(clientId) => clientId && set({ clientId })} />
        <SelectField
          label="Operation"
          value={workload.operation as (typeof OPERATIONS)[number]}
          options={OPERATIONS.map((o) => ({ value: o, label: o }))}
          onChange={(operation) => set({ operation })}
        />
        <SelectField
          label="Arrivals"
          hint={
            arrival.kind === 'poisson'
              ? 'Random gaps with the right average — bursty, like real traffic'
              : arrival.kind === 'constant'
                ? 'Evenly spaced'
                : arrival.kind === 'burst'
                  ? 'Batches at a fixed interval'
                  : 'All at once'
          }
          value={arrival.kind}
          options={[
            { value: 'poisson', label: 'Poisson (random)' },
            { value: 'constant', label: 'Constant rate' },
            { value: 'burst', label: 'Bursts' },
            { value: 'once', label: 'Once' },
          ]}
          onChange={(kind) => set({ arrival: defaultArrival(kind) })}
        />
        {arrival.kind === 'poisson' || arrival.kind === 'constant' ? (
          <NumberField label="Rate" value={arrival.ratePerSec} min={0.01} suffix="req/s" onChange={(ratePerSec) => ratePerSec && set({ arrival: { ...arrival, ratePerSec } })} />
        ) : null}
        {arrival.kind === 'burst' ? (
          <div className="grid-2">
            <NumberField label="Burst size" value={arrival.count} min={1} onChange={(count) => count && set({ arrival: { ...arrival, count } })} />
            <NumberField label="Every" value={arrival.everyMs} min={1} suffix="ms" onChange={(everyMs) => everyMs && set({ arrival: { ...arrival, everyMs } })} />
          </div>
        ) : null}
        {arrival.kind === 'once' ? (
          <NumberField label="Requests" value={arrival.count} min={1} onChange={(count) => count && set({ arrival: { kind: 'once', count } })} />
        ) : null}
        <NumberField
          label="Deadline"
          hint="How long the client waits before giving up on a request"
          value={workload.deadlineMs}
          min={1}
          suffix="ms"
          optional
          placeholder="5000"
          onChange={(deadlineMs) => set({ deadlineMs })}
        />
        <div className="grid-2">
          <NumberField label="Start at" value={workload.startAt} min={0} suffix="ms" optional placeholder="0" onChange={(startAt) => set({ startAt })} />
          <NumberField label="Stop at" value={workload.stopAt} min={0} suffix="ms" optional placeholder="end" onChange={(stopAt) => set({ stopAt })} />
        </div>
        <div className="grid-2">
          <NumberField label="Max requests" value={workload.maxRequests} min={1} optional placeholder="∞" onChange={(maxRequests) => set({ maxRequests })} />
          <NumberField label="Size" value={workload.sizeBytes} min={0} suffix="B" optional placeholder="512" onChange={(sizeBytes) => set({ sizeBytes })} />
        </div>
      </Section>
      <Section title="Data keys" open={workload.keys !== undefined}>
        <div className="grid-2">
          <NumberField
            label="Key space"
            hint="Requests pick key-0 … key-N-1"
            value={workload.keys}
            min={1}
            optional
            placeholder="none"
            onChange={(keys) => set({ keys })}
          />
          <PercentField label="Hot key share" hint="Traffic sent to key-0" value={workload.hotKeyShare} onChange={(hotKeyShare) => set({ hotKeyShare })} />
        </div>
      </Section>
      <Section title="Operation mix" open={mix.length > 0}>
        <div className="field-hint">Weighted mix of operations, e.g. 9 reads to 1 write. Empty means only the operation above.</div>
        {mix.map((entry, index) => (
          <div key={index} className="row" style={{ alignItems: 'end' }}>
            <div style={{ flex: 1 }}>
              <SelectField
                label="Operation"
                value={entry.operation as (typeof OPERATIONS)[number]}
                options={OPERATIONS.map((o) => ({ value: o, label: o }))}
                onChange={(operation) => set({ mix: mix.map((m, i) => (i === index ? { ...m, operation } : m)) })}
              />
            </div>
            <div style={{ width: 90 }}>
              <NumberField
                label="Weight"
                value={entry.weight}
                min={0.0001}
                onChange={(weight) => weight && set({ mix: mix.map((m, i) => (i === index ? { ...m, weight } : m)) })}
              />
            </div>
            <button className="btn icon ghost" aria-label="Remove" onClick={() => set({ mix: mix.filter((_, i) => i !== index) })}>
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
        <button
          className="btn"
          onClick={() =>
            set({
              mix: mix.length === 0
                ? [{ operation: 'DB_READ', weight: 9 }, { operation: 'DB_WRITE', weight: 1 }]
                : [...mix, { operation: 'HTTP_GET', weight: 1 }],
            })
          }
        >
          <Icon name="plus" size={13} /> Add operation
        </button>
      </Section>
    </>
  );
}
