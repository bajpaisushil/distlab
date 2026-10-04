'use client';

import { resolveSimulationSpec, type LatencySpec, type NodeId } from '@distlab/shared';
import { useLab } from '@/lib/store';
import { NODE_LABELS } from '@/lib/spec-edit';
import { LatencyField, NumberField, PercentField, TextField } from '@/components/ui/fields';
import { Icon, NodeGlyph } from '@/components/ui/icons';
import { formatCount, formatPercent } from '@/lib/format';
import { healthOf } from '@/components/canvas/SimNodeView';
import { Header, KV, Section } from './common';
import { ModuleNodeSections } from './ModuleNodeSections';

export function NodeInspector({ id }: { id: NodeId }) {
  const spec = useLab((s) => s.spec);
  const live = useLab((s) => s.frame?.nodes.find((n) => n.id === id));
  const now = useLab((s) => s.frame?.now ?? 0);
  const lab = useLab.getState();
  const node = spec.nodes.find((n) => n.id === id);
  if (!node) return <div className="empty">That node no longer exists.</div>;

  const resolved = resolveSimulationSpec(spec).nodes.find((n) => n.id === id)!.config;
  const config = node.config ?? {};
  const set = (patch: Record<string, unknown>) => lab.updateNode(id, { config: patch });
  const health = healthOf(live, resolved);
  const isStorage = node.type === 'database' || node.type === 'replica';
  const workloads = spec.workloads.filter((w) => w.clientId === id);

  return (
    <>
      <Header
        icon={
          <span className="node-icon">
            <NodeGlyph type={node.type} size={15} />
          </span>
        }
        title={node.label ?? node.id}
        subtitle={
          <>
            {NODE_LABELS[node.type]} · <span className="mono">{node.id}</span>
          </>
        }
        onClose={() => lab.select(null)}
        actions={
          <>
            {node.type !== 'client' ? (
              <button
                className="btn"
                onClick={() => {
                  const faultId = lab.addFault({ kind: 'node_crash', at: Math.round(now), nodeId: id, recoverAfter: 2000 });
                  lab.select({ kind: 'fault', id: faultId });
                }}
                title="Schedule a crash at the current moment, recovering 2s later"
              >
                <Icon name="bolt" size={13} /> Crash now
              </button>
            ) : null}
            {node.type !== 'client' ? (
              <button
                className="btn"
                onClick={() => {
                  const faultId = lab.addFault({ kind: 'node_pause', at: Math.round(now), nodeId: id, durationMs: 1500 });
                  lab.select({ kind: 'fault', id: faultId });
                }}
                title="Freeze the process for 1.5s from the current moment — a stop-the-world GC pause"
              >
                Freeze
              </button>
            ) : (
              <button className="btn" onClick={() => lab.select({ kind: 'workload', id: lab.addWorkload(id) })}>
                <Icon name="plus" size={13} /> Add workload
              </button>
            )}
            <button className="btn danger" onClick={() => lab.removeNode(id)}>
              <Icon name="trash" size={13} /> Delete
            </button>
          </>
        }
      />
      <Section title="Live state">
        <KV
          rows={[
            [
              'Status',
              <span key="s" className={`pill status-${health.tone}`}>
                <span className="dot" />
                {health.label}
              </span>,
            ],
            ...(node.type !== 'client'
              ? ([
                  ['In progress', `${live?.inFlight ?? 0} of ${resolved.concurrency} slots`],
                  ['Waiting', `${live?.queueDepth ?? 0} of ${resolved.queueCapacity}`],
                  ['Utilisation', formatPercent(live?.utilization ?? 0)],
                  ['Rejected', formatCount(live?.rejected ?? 0)],
                ] as const)
              : []),
            ['Served', formatCount(live?.processed ?? 0)],
            ['Failed', formatCount(live?.failed ?? 0)],
          ]}
        />
      </Section>
      <Section title="Configuration">
        <TextField label="Label" value={node.label ?? node.id} onChange={(label) => lab.updateNode(id, { label })} />
        {node.type !== 'client' ? (
          <>
            <LatencyField
              label={isStorage ? 'Processing (other operations)' : 'Processing time'}
              value={config.processing ?? resolved.processing}
              onChange={(processing: LatencySpec | undefined) => set({ processing })}
            />
            {isStorage ? (
              <div className="grid-2">
                <LatencyField label="Read latency" value={config.readLatency ?? resolved.readLatency} onChange={(readLatency) => set({ readLatency })} />
                <LatencyField label="Write latency" value={config.writeLatency ?? resolved.writeLatency} onChange={(writeLatency) => set({ writeLatency })} />
              </div>
            ) : null}
            <div className="grid-2">
              <NumberField
                label="Concurrency"
                hint="Requests worked on at once"
                value={config.concurrency ?? resolved.concurrency}
                min={1}
                onChange={(concurrency) => set({ concurrency })}
              />
              <NumberField
                label="Queue capacity"
                hint="Waiting room before rejecting"
                value={config.queueCapacity ?? resolved.queueCapacity}
                min={0}
                onChange={(queueCapacity) => set({ queueCapacity })}
              />
            </div>
            <PercentField
              label="Failure probability"
              hint="Chance any single request fails here, regardless of load"
              value={config.failureProbability}
              onChange={(failureProbability) => set({ failureProbability })}
            />
          </>
        ) : null}
      </Section>
      <ModuleNodeSections node={node} />
      {node.type === 'client' ? <SendOneRequest clientId={id} /> : null}
      {node.type === 'client' ? (
        <Section title="Workloads">
          {workloads.length === 0 ? <div className="muted">This client sends nothing.</div> : null}
          {workloads.map((w) => (
            <div key={w.id} className="list-item" onClick={() => lab.select({ kind: 'workload', id: w.id })}>
              <Icon name="activity" size={14} />
              <span>{w.id}</span>
              <span className="spacer" />
              <span className="muted">{w.arrival.kind}</span>
            </div>
          ))}
        </Section>
      ) : null}
    </>
  );
}

/**
 * Issue a single write or read at the current moment, then press play and
 * watch it in Events and Traces — the way to see eventual consistency happen.
 */
function SendOneRequest({ clientId }: { clientId: NodeId }) {
  const spec = useLab((s) => s.spec);
  const now = useLab((s) => s.frame?.now ?? 0);
  const lab = useLab.getState();
  const hasStorage = spec.nodes.some((n) => n.type === 'database');
  const hasReplica = spec.nodes.some((n) => n.type === 'replica');
  const actions: { label: string; operation: string }[] = hasStorage
    ? [
        { label: 'Write', operation: 'WRITE' },
        { label: 'Read primary', operation: 'READ_PRIMARY' },
        ...(hasReplica ? [{ label: 'Read replica', operation: 'READ_REPLICA' }] : []),
      ]
    : [{ label: 'HTTP GET', operation: 'HTTP_GET' }];
  return (
    <Section title="Send one request" open>
      <div className="field-hint">
        Sent at {(now / 1000).toFixed(2)}s, then press play. All one-off requests use the same key, so a write followed by a replica read shows whether
        the replica has caught up.
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {actions.map((a) => (
          <button key={a.operation} className="btn" onClick={() => lab.sendOneRequest(clientId, a.operation)} data-testid={`send-${a.operation}`}>
            {a.label}
          </button>
        ))}
      </div>
    </Section>
  );
}
