import type { NodeSpec } from '@distlab/shared';
import type { ModuleTelemetry } from '@distlab/telemetry';

export type Badge = { label: string; tone?: 'good' | 'warning' | 'serious' | 'critical' };

/**
 * One-word facts subsystems contribute to a node card — the cluster leader,
 * the current lock holder, a lagging replica. Read from telemetry sections;
 * a subsystem with nothing to say contributes nothing.
 */
export function nodeBadges(_node: NodeSpec, _modules: ModuleTelemetry | undefined): Badge[] {
  return [];
}
