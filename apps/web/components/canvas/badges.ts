import { routingStrategyOf, type NodeSpec } from '@distlab/shared';
import type { ModuleTelemetry } from '@distlab/telemetry';

export type Badge = { label: string; tone?: 'good' | 'warning' | 'serious' | 'critical' };

const STRATEGY_SHORT: Record<string, string> = {
  first_available: 'first available',
  round_robin: 'round robin',
  weighted_round_robin: 'weighted RR',
  least_connections: 'least conn',
  random: 'random',
  latency_aware: 'latency-aware',
  consistent_hash: 'hash ring',
};

/**
 * One-word facts subsystems contribute to a node card — the strategy a
 * balancer uses, the cluster leader, the current lock holder, a lagging
 * replica. Read from configuration and telemetry; a subsystem with nothing
 * to say contributes nothing.
 */
export function nodeBadges(node: NodeSpec, modules: ModuleTelemetry | undefined): Badge[] {
  const badges: Badge[] = [];
  for (const circuit of modules?.reliability.circuits ?? []) {
    if (circuit.nodeId !== node.id || circuit.state === 'closed') continue;
    badges.push({
      label: `${circuit.state === 'open' ? 'circuit open' : 'half-open'} → ${circuit.target}`,
      tone: circuit.state === 'open' ? 'serious' : 'warning',
    });
  }
  if (node.type === 'load_balancer' || node.type === 'gateway') {
    badges.push({ label: STRATEGY_SHORT[routingStrategyOf(node.config ?? {})] ?? 'routing' });
  }
  return badges;
}
