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
  for (const replica of modules?.data.replicas ?? []) {
    if (replica.replicaId !== node.id) continue;
    const last = replica.lag[replica.lag.length - 1];
    if (last) badges.push({ label: `lag ${Math.round(last.value)}ms`, tone: last.value > 500 ? 'warning' : 'good' });
    if (replica.staleReads > 0) badges.push({ label: `${Math.round(replica.staleRate * 100)}% stale`, tone: 'warning' });
  }
  for (const cache of modules?.data.caches ?? []) {
    if (cache.nodeId === node.id && cache.hits + cache.misses > 0) {
      badges.push({ label: `hit ${Math.round(cache.hitRatio * 100)}%`, tone: cache.hitRatio > 0.8 ? 'good' : 'warning' });
    }
  }
  for (const queue of modules?.queues.queues ?? []) {
    if (queue.queueId !== node.id) continue;
    if (queue.deadLettered > 0) badges.push({ label: `${queue.deadLettered} dead`, tone: 'critical' });
    if (queue.rejected > 0) badges.push({ label: `${queue.rejected} refused`, tone: 'warning' });
  }
  return badges;
}
