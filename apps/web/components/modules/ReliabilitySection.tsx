'use client';

import {
  BACKOFF_KINDS,
  JITTER_KINDS,
  type BulkheadPolicy,
  type CircuitBreakerPolicy,
  type NodeSpec,
  type RetryPolicy,
} from '@distlab/shared';
import { useLab } from '@/lib/store';
import { NumberField, SelectField, TextField, ToggleField } from '@/components/ui/fields';
import { Icon } from '@/components/ui/icons';
import { Section } from '@/components/inspector/common';

const CALLERS = new Set(['client', 'load_balancer', 'gateway', 'api', 'service', 'worker', 'cache']);

const JITTER_HINT: Record<string, string> = {
  none: 'Every caller retries at the same moment — a synchronised wave',
  full: 'Random between 0 and the backoff — spreads retries out the most',
  equal: 'Half the backoff plus a random half',
  decorrelated: 'Grows from the previous delay (AWS-style)',
};

export function ReliabilitySection({ node }: { node: NodeSpec }) {
  const spec = useLab((s) => s.spec);
  const lab = useLab.getState();
  if (!CALLERS.has(node.type) || !spec.links.some((l) => l.from === node.id)) return null;
  const config = node.config ?? {};
  const set = (patch: Record<string, unknown>) => lab.updateNode(node.id, { config: patch });
  const retry = config.retry;
  const breaker = config.circuitBreaker;
  const bulkheads = config.bulkheads ?? [];
  const setRetry = (patch: Partial<RetryPolicy>) => set({ retry: { ...(retry ?? { maxRetries: 2 }), ...patch } });
  const setBreaker = (patch: Partial<CircuitBreakerPolicy>) =>
    set({ circuitBreaker: { ...(breaker ?? { failureThreshold: 5, cooldownMs: 1000 }), ...patch } });
  const workloadIds = spec.workloads.map((w) => w.id);

  return (
    <Section title="Timeouts, retries & breakers" open={Boolean(config.callTimeoutMs || retry || breaker)}>
      <NumberField
        label="Call timeout"
        hint="Give up on one downstream attempt after this long (empty: wait until the request's deadline)"
        value={config.callTimeoutMs}
        min={1}
        optional
        suffix="ms"
        placeholder="deadline"
        onChange={(callTimeoutMs) => set({ callTimeoutMs })}
      />

      <ToggleField label="Retry failed calls" checked={retry !== undefined} onChange={(on) => set({ retry: on ? { maxRetries: 2, backoff: 'exponential', baseDelayMs: 50, jitter: 'full' } : undefined })} />
      {retry ? (
        <div className="stack" style={{ paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
          <div className="grid-2">
            <NumberField label="Max retries" value={retry.maxRetries} min={0} onChange={(maxRetries) => maxRetries !== undefined && setRetry({ maxRetries: Math.round(maxRetries) })} />
            <SelectField
              label="Backoff"
              value={retry.backoff ?? 'exponential'}
              options={BACKOFF_KINDS.map((k) => ({ value: k, label: k }))}
              onChange={(backoff) => setRetry({ backoff })}
            />
          </div>
          <div className="grid-2">
            <NumberField label="Base delay" value={retry.baseDelayMs} min={0} optional suffix="ms" placeholder="50" onChange={(baseDelayMs) => setRetry({ baseDelayMs })} />
            <NumberField label="Max delay" value={retry.maxDelayMs} min={0} optional suffix="ms" placeholder="2000" onChange={(maxDelayMs) => setRetry({ maxDelayMs })} />
          </div>
          <SelectField
            label="Jitter"
            hint={JITTER_HINT[retry.jitter ?? 'full']}
            value={retry.jitter ?? 'full'}
            options={JITTER_KINDS.map((k) => ({ value: k, label: k }))}
            onChange={(jitter) => setRetry({ jitter })}
          />
          <ToggleField label="Retry the same target" hint="Otherwise the balancer chooses again" checked={retry.retrySameTarget ?? false} onChange={(retrySameTarget) => setRetry({ retrySameTarget })} />
        </div>
      ) : null}

      <ToggleField
        label="Circuit breaker"
        hint="Stop calling a target that keeps failing; probe it after a cooldown"
        checked={breaker !== undefined}
        onChange={(on) => set({ circuitBreaker: on ? { failureThreshold: 5, cooldownMs: 1000 } : undefined })}
      />
      {breaker ? (
        <div className="stack" style={{ paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
          <div className="grid-2">
            <NumberField label="Open after" hint="Consecutive failures" value={breaker.failureThreshold} min={1} onChange={(failureThreshold) => failureThreshold && setBreaker({ failureThreshold: Math.round(failureThreshold) })} />
            <NumberField label="Cooldown" value={breaker.cooldownMs} min={1} suffix="ms" onChange={(cooldownMs) => cooldownMs && setBreaker({ cooldownMs })} />
          </div>
          <NumberField label="Probes when half-open" value={breaker.halfOpenMaxCalls} min={1} optional placeholder="1" onChange={(halfOpenMaxCalls) => setBreaker({ halfOpenMaxCalls })} />
        </div>
      ) : null}

      {node.type !== 'client' ? (
        <div className="stack">
          <div className="row">
            <span className="field-label">Bulkheads</span>
            <span className="spacer" />
            <button
              className="btn ghost"
              style={{ height: 22, padding: '0 6px' }}
              onClick={() =>
                set({
                  bulkheads: [
                    ...bulkheads,
                    { name: `class-${bulkheads.length + 1}`, workloads: workloadIds.slice(0, 1), maxConcurrent: Math.max(1, Math.floor((config.concurrency ?? 8) / 2)) },
                  ],
                })
              }
            >
              <Icon name="plus" size={12} /> Add
            </button>
          </div>
          <span className="field-hint">Cap how much of this node one class of traffic can use, so a flood in one cannot starve another.</span>
          {bulkheads.map((bulkhead, index) => (
            <BulkheadEditor
              key={index}
              bulkhead={bulkhead}
              workloadIds={workloadIds}
              onChange={(next) => set({ bulkheads: bulkheads.map((b, i) => (i === index ? next : b)) })}
              onRemove={() => set({ bulkheads: bulkheads.length === 1 ? undefined : bulkheads.filter((_, i) => i !== index) })}
            />
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function BulkheadEditor({
  bulkhead,
  workloadIds,
  onChange,
  onRemove,
}: {
  bulkhead: BulkheadPolicy;
  workloadIds: readonly string[];
  onChange(next: BulkheadPolicy): void;
  onRemove(): void;
}) {
  return (
    <div className="stack" style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 6, gap: 8 }}>
      <div className="row" style={{ alignItems: 'end' }}>
        <div style={{ flex: 1 }}>
          <TextField label="Name" value={bulkhead.name} onChange={(name) => onChange({ ...bulkhead, name })} />
        </div>
        <button className="btn icon ghost" aria-label="Remove bulkhead" onClick={onRemove}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      <div className="field">
        <span className="field-label">Workloads in this class</span>
        {workloadIds.map((id) => (
          <label key={id} className="toggle">
            <input
              type="checkbox"
              checked={bulkhead.workloads.includes(id)}
              onChange={(e) =>
                onChange({ ...bulkhead, workloads: e.target.checked ? [...bulkhead.workloads, id] : bulkhead.workloads.filter((w) => w !== id) })
              }
            />
            <span className="mono">{id}</span>
          </label>
        ))}
      </div>
      <div className="grid-2">
        <NumberField label="Max concurrent" value={bulkhead.maxConcurrent} min={1} onChange={(maxConcurrent) => maxConcurrent && onChange({ ...bulkhead, maxConcurrent: Math.round(maxConcurrent) })} />
        <NumberField label="Max queued" value={bulkhead.maxQueue} min={0} optional placeholder="node’s" onChange={(maxQueue) => onChange({ ...bulkhead, ...(maxQueue === undefined ? { maxQueue: undefined } : { maxQueue: Math.round(maxQueue) }) } as BulkheadPolicy)} />
      </div>
    </div>
  );
}
