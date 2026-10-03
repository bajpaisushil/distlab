'use client';

import { RoutingMetrics } from '@/components/modules/RoutingMetrics';
import { ReliabilityMetrics } from '@/components/modules/ReliabilityMetrics';

/**
 * Subsystem sections of the metrics panel. Each renders its own telemetry
 * section and nothing when its subsystem is not in use.
 */
export function ModuleMetrics() {
  return (
    <>
      <RoutingMetrics />
      <ReliabilityMetrics />
    </>
  );
}
