'use client';

import {
  DEFAULT_EWMA_ALPHA,
  DEFAULT_EWMA_TTL_MS,
  DEFAULT_VIRTUAL_NODES,
  ROUTING_STRATEGIES,
  routingStrategyOf,
  type NodeSpec,
  type RoutingStrategyName,
} from '@distlab/shared';
import { useLab } from '@/lib/store';
import { NumberField, SelectField } from '@/components/ui/fields';
import { Section } from '@/components/inspector/common';

export const STRATEGY_INFO: Record<RoutingStrategyName, { label: string; summary: string }> = {
  first_available: {
    label: 'First available',
    summary: 'Always the first healthy target. No balancing at all — a baseline that shows why balancing matters.',
  },
  round_robin: { label: 'Round robin', summary: 'Each target in turn. Even when targets are equal; blind to a slow one.' },
  weighted_round_robin: {
    label: 'Weighted round robin',
    summary: 'In proportion to each target’s weight, interleaved smoothly (nginx’s algorithm). For unequal capacity.',
  },
  least_connections: {
    label: 'Least connections',
    summary: 'The target with the fewest requests in flight from this node. A slow target accumulates in-flight work and stops being chosen.',
  },
  random: { label: 'Random', summary: 'A uniform random choice. Even on average, with no memory and no coordination.' },
  latency_aware: {
    label: 'Latency-aware',
    summary: 'Best of two random targets by observed latency × load. Steers away from slow targets without herding onto one.',
  },
  consistent_hash: {
    label: 'Consistent hash',
    summary: 'By the request’s data key, so a key always lands on the same target. Losing a target only moves its keys.',
  },
};

const FORWARDERS = new Set(['client', 'load_balancer', 'gateway', 'api', 'service', 'worker']);

export function RoutingSection({ node }: { node: NodeSpec }) {
  const spec = useLab((s) => s.spec);
  const lab = useLab.getState();
  const config = node.config ?? {};
  const set = (patch: Record<string, unknown>) => lab.updateNode(node.id, { config: patch });
  const downstream = spec.links.filter((l) => l.from === node.id).length;
  const strategy = routingStrategyOf(config);
  const forwards = FORWARDERS.has(node.type) && downstream > 0;
  const isTarget = node.type !== 'client' && spec.links.some((l) => l.to === node.id);
  if (!forwards && !isTarget) return null;

  return (
    <Section title="Load balancing" open={node.type === 'load_balancer' || node.type === 'gateway'}>
      {forwards ? (
        <>
          <SelectField
            label={downstream > 1 ? `Strategy across ${downstream} targets` : 'Strategy'}
            hint={STRATEGY_INFO[strategy].summary}
            value={strategy}
            options={ROUTING_STRATEGIES.map((s) => ({ value: s, label: STRATEGY_INFO[s].label }))}
            onChange={(routing) => set({ routing })}
          />
          {strategy === 'latency_aware' ? (
            <div className="grid-2">
              <NumberField
                label="Smoothing (α)"
                hint="Weight of the newest sample"
                value={config.ewmaAlpha}
                min={0.01}
                max={1}
                optional
                placeholder={String(DEFAULT_EWMA_ALPHA)}
                onChange={(ewmaAlpha) => set({ ewmaAlpha })}
              />
              <NumberField
                label="Estimate lifetime"
                hint="Re-probe after this long unheard"
                value={config.ewmaTtlMs}
                min={1}
                suffix="ms"
                optional
                placeholder={String(DEFAULT_EWMA_TTL_MS)}
                onChange={(ewmaTtlMs) => set({ ewmaTtlMs })}
              />
            </div>
          ) : null}
          {strategy === 'consistent_hash' ? (
            <NumberField
              label="Virtual nodes per target"
              hint="More points, smoother spread. Requests need data keys (set Key space on the workload)."
              value={config.virtualNodes}
              min={1}
              optional
              placeholder={String(DEFAULT_VIRTUAL_NODES)}
              onChange={(virtualNodes) => set({ virtualNodes })}
            />
          ) : null}
        </>
      ) : null}
      {isTarget ? (
        <NumberField
          label="Weight"
          hint="Relative capacity, used when an upstream balances by weighted round robin"
          value={config.weight}
          min={0.01}
          optional
          placeholder="1"
          onChange={(weight) => set({ weight })}
        />
      ) : null}
    </Section>
  );
}
