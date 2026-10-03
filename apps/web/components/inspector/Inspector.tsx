'use client';

import { useLab } from '@/lib/store';
import { ScenarioInspector } from './ScenarioInspector';
import { NodeInspector } from './NodeInspector';
import { LinkInspector } from './LinkInspector';
import { WorkloadInspector } from './WorkloadInspector';
import { FaultInspector } from './FaultInspector';
import { EventInspector } from './EventInspector';
import { TraceInspector } from './TraceInspector';

/** Edits or explains whatever is selected. Nothing selected means the scenario itself. */
export function Inspector() {
  const selection = useLab((s) => s.selection);
  return (
    <aside className="inspector" aria-label="Inspector" data-testid="inspector">
      {selection === null || selection.kind === 'scenario' ? <ScenarioInspector /> : null}
      {selection?.kind === 'node' ? <NodeInspector id={selection.id} /> : null}
      {selection?.kind === 'link' ? <LinkInspector id={selection.id} /> : null}
      {selection?.kind === 'workload' ? <WorkloadInspector id={selection.id} /> : null}
      {selection?.kind === 'fault' ? <FaultInspector id={selection.id} /> : null}
      {selection?.kind === 'event' ? <EventInspector id={selection.id} /> : null}
      {selection?.kind === 'trace' ? <TraceInspector id={selection.id} /> : null}
    </aside>
  );
}
