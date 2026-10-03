'use client';

import {
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_HOLD_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_THINK_MS,
  renewIntervalOf,
  type LockClientPolicy,
  type NodeSpec,
} from '@distlab/shared';
import { useLab } from '@/lib/store';
import { LatencyField, NodeRefField, NumberField, TextField, ToggleField } from '@/components/ui/fields';
import { Section } from '@/components/inspector/common';

const CAN_HOLD = new Set(['api', 'service', 'worker', 'gateway']);
const STORAGE = new Set(['database', 'replica', 'cache', 'service', 'api']);

/** Lock service settings, lock-client behaviour, and fencing at storage — whichever apply to this node. */
export function LockSection({ node }: { node: NodeSpec }) {
  const spec = useLab((s) => s.spec);
  const lab = useLab.getState();
  const config = node.config ?? {};
  const services = spec.nodes.filter((n) => n.type === 'lock_service');
  const writtenBy = spec.nodes.filter((n) => n.config?.lockClient?.storage === node.id);

  if (node.type === 'lock_service') {
    const policy = config.lockService ?? {};
    const set = (patch: Record<string, unknown>) => lab.updateNode(node.id, { config: { lockService: { ...policy, ...patch } } });
    const holders = spec.nodes.filter((n) => n.config?.lockClient?.service === node.id);
    return (
      <Section title="Lock service" open>
        <div className="field-hint">
          Hands out named locks with leases and fencing tokens to {holders.length} client{holders.length === 1 ? '' : 's'}. Give a server
          a lock in its own settings.
        </div>
        <NumberField
          label="Default lease"
          value={policy.defaultLeaseMs}
          min={1}
          optional
          suffix="ms"
          placeholder={String(DEFAULT_LEASE_MS)}
          onChange={(defaultLeaseMs) => set({ defaultLeaseMs })}
        />
        <NumberField
          label="Max waiters per lock"
          hint="Beyond this, a request is refused at once instead of queued"
          value={policy.maxWaiters}
          min={1}
          optional
          placeholder="unlimited"
          onChange={(maxWaiters) => set({ maxWaiters: maxWaiters === undefined ? undefined : Math.round(maxWaiters) })}
        />
        <NumberField
          label="Grace after restart"
          hint="The lock table lives in memory. After a crash, wait this long before granting so old leases run out. 0 risks two holders."
          value={policy.recoveryGraceMs}
          min={0}
          optional
          suffix="ms"
          placeholder="longest lease"
          onChange={(recoveryGraceMs) => set({ recoveryGraceMs })}
        />
      </Section>
    );
  }

  const fencing =
    STORAGE.has(node.type) && (writtenBy.length > 0 || config.fencing !== undefined) ? (
      <Section title="Fencing" open>
        <ToggleField
          label="Reject stale fencing tokens"
          hint={`Remember the highest lock token written here and refuse anything older — a holder whose lease ran out. ${
            writtenBy.length > 0 ? `Written under lock by ${writtenBy.map((n) => n.label ?? n.id).join(', ')}.` : ''
          }`}
          checked={config.fencing ?? false}
          onChange={(fencing) => lab.updateNode(node.id, { config: { fencing } })}
        />
      </Section>
    ) : null;

  if (!CAN_HOLD.has(node.type)) return fencing;

  const client = config.lockClient;
  const firstService = services[0];
  const enable = (on: boolean) => {
    if (!on) return lab.updateNode(node.id, { config: { lockClient: undefined } });
    if (!firstService) return;
    const storage = spec.nodes.find((n) => n.type === 'database');
    const policy: LockClientPolicy = { service: firstService.id, resource: 'resource-1', ...(storage ? { storage: storage.id } : {}) };
    lab.updateNode(node.id, { config: { lockClient: policy }, connectTo: [firstService.id, ...(storage ? [storage.id] : [])] });
  };
  const set = (patch: Partial<LockClientPolicy>) => {
    if (!client) return;
    const next = { ...client, ...patch };
    lab.updateNode(node.id, { config: { lockClient: next }, connectTo: [next.service, ...(next.storage ? [next.storage] : [])] });
  };

  return (
    <>
      <Section title="Distributed lock" open={client !== undefined}>
        <ToggleField
          label="Work under a lock"
          hint={
            firstService
              ? 'Loop: ask for the lock, work while renewing the lease, write with the fencing token, release.'
              : 'Add a Lock service node first.'
          }
          checked={client !== undefined}
          onChange={enable}
        />
        {client ? (
          <>
            <NodeRefField label="Lock service" value={client.service} spec={spec} types={['lock_service']} onChange={(service) => service && set({ service })} />
            <TextField label="Lock name" value={client.resource} onChange={(resource) => resource && set({ resource })} />
            <div className="grid-2">
              <NumberField label="Lease" value={client.leaseMs} min={1} optional suffix="ms" placeholder={String(DEFAULT_LEASE_MS)} onChange={(leaseMs) => set({ leaseMs })} />
              <NumberField
                label="Renew every"
                value={client.renewEveryMs}
                min={0}
                optional
                suffix="ms"
                placeholder={String(renewIntervalOf({ ...client, renewEveryMs: undefined }))}
                onChange={(renewEveryMs) => set({ renewEveryMs })}
              />
            </div>
            <LatencyField label="Work while holding" value={client.holdMs ?? DEFAULT_HOLD_MS} onChange={(holdMs) => holdMs !== undefined && set({ holdMs })} />
            <LatencyField label="Pause between turns" value={client.thinkMs ?? DEFAULT_THINK_MS} onChange={(thinkMs) => thinkMs !== undefined && set({ thinkMs })} />
            <NumberField
              label="Stop waiting after"
              value={client.acquireTimeoutMs}
              min={1}
              optional
              suffix="ms"
              placeholder={String(DEFAULT_ACQUIRE_TIMEOUT_MS)}
              onChange={(acquireTimeoutMs) => set({ acquireTimeoutMs })}
            />
            <NodeRefField
              label="Writes to"
              hint="The write at the end of each turn carries the fencing token"
              value={client.storage}
              spec={spec}
              exclude={node.id}
              types={['database', 'replica', 'cache', 'service', 'api']}
              allowNone
              onChange={(storage) => set({ storage })}
            />
            <ToggleField
              label="Check the lease before writing"
              hint="Narrows the window but cannot close it: the write can still be delayed after the check."
              checked={client.checkLeaseBeforeWrite ?? false}
              onChange={(checkLeaseBeforeWrite) => set({ checkLeaseBeforeWrite })}
            />
          </>
        ) : null}
      </Section>
      {fencing}
    </>
  );
}
