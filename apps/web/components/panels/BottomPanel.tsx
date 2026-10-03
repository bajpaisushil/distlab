'use client';

import { useLab, type BottomTab } from '@/lib/store';
import { Icon, type IconName } from '@/components/ui/icons';
import { MetricsPanel } from './MetricsPanel';
import { EventsPanel } from './EventsPanel';
import { LogsPanel } from './LogsPanel';
import { TracesPanel } from './TracesPanel';
import { ExplainPanel } from './ExplainPanel';

const TABS: readonly { id: BottomTab; label: string; icon: IconName }[] = [
  { id: 'metrics', label: 'Metrics', icon: 'activity' },
  { id: 'events', label: 'Events', icon: 'list' },
  { id: 'logs', label: 'Logs', icon: 'terminal' },
  { id: 'traces', label: 'Traces', icon: 'waterfall' },
  { id: 'explain', label: 'Explain', icon: 'sparkles' },
];

export function BottomPanel() {
  const tab = useLab((s) => s.bottomTab);
  const open = useLab((s) => s.bottomOpen);
  const failed = useLab((s) => s.frame?.snapshot.requests.failed ?? 0);
  const setTab = useLab((s) => s.setBottomTab);
  const toggle = useLab((s) => s.toggleBottom);

  return (
    <section className={`dock${open ? '' : ' collapsed'}`} aria-label="Telemetry">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            className="tab"
            aria-selected={open && tab === t.id}
            onClick={() => setTab(t.id)}
            data-testid={`tab-${t.id}`}
          >
            <Icon name={t.icon} size={13} />
            {t.label}
            {t.id === 'events' && failed > 0 ? <span className="count">{failed} failed</span> : null}
          </button>
        ))}
        <span className="spacer" />
        <button className="btn icon ghost" onClick={() => toggle()} aria-label={open ? 'Collapse panel' : 'Expand panel'} title={open ? 'Collapse' : 'Expand'}>
          <Icon name="chevronDown" size={14} className={open ? '' : 'flip'} />
        </button>
      </div>
      {open ? (
        <div className="dock-body" role="tabpanel">
          {tab === 'metrics' ? <MetricsPanel /> : null}
          {tab === 'events' ? <EventsPanel /> : null}
          {tab === 'logs' ? <LogsPanel /> : null}
          {tab === 'traces' ? <TracesPanel /> : null}
          {tab === 'explain' ? <ExplainPanel /> : null}
        </div>
      ) : null}
    </section>
  );
}
