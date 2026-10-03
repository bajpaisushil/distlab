'use client';

import { useLab } from '@/lib/store';
import { BarList } from '@/components/charts/BarList';
import { formatCount, formatPercent } from '@/lib/format';
import { STRATEGY_INFO } from './RoutingSection';

/** How each balancer actually spread its traffic — including targets that got nothing. */
export function RoutingMetrics() {
  const routing = useLab((s) => s.frame?.snapshot.modules.routing);
  const spec = useLab((s) => s.spec);
  if (!routing || routing.nodes.length === 0) return null;
  const label = (id: string) => spec.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div className="chart-grid">
      {routing.nodes.map((node) => (
        <BarList
          key={node.nodeId}
          title={`${label(node.nodeId)} — ${STRATEGY_INFO[node.strategy as keyof typeof STRATEGY_INFO]?.label ?? node.strategy}`}
          subtitle={`${formatCount(node.total)} requests routed · imbalance ${node.imbalance.toFixed(2)} (0 = perfectly even)`}
          max={1}
          items={node.targets.map((t) => ({
            id: t.id,
            label: label(t.id),
            value: t.share,
            display: `${formatPercent(t.share, 0)} · ${formatCount(t.dispatched)}`,
          }))}
        />
      ))}
    </div>
  );
}
