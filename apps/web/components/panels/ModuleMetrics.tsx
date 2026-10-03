'use client';

import { RoutingMetrics } from '@/components/modules/RoutingMetrics';
import { ReliabilityMetrics } from '@/components/modules/ReliabilityMetrics';
import { DataMetrics } from '@/components/modules/DataMetrics';
import { QueueMetrics } from '@/components/modules/QueueMetrics';
import { ConsensusMetrics } from '@/components/modules/ConsensusMetrics';

/**
 * Subsystem sections of the metrics panel. Each renders its own telemetry
 * section and nothing when its subsystem is not in use.
 */
export function ModuleMetrics() {
  return (
    <>
      <RoutingMetrics />
      <ReliabilityMetrics />
      <DataMetrics />
      <QueueMetrics />
      <ConsensusMetrics />
    </>
  );
}
