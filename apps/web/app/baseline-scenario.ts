import { SPEC_VERSION, type SimulationSpec } from '@distlab/shared';

/**
 * The scenario the landing page runs.
 *
 * Deliberately small and fully specified: a reader can work out by hand what
 * the engine should report, which is the point of showing it at all.
 */
export const BASELINE_SCENARIO: SimulationSpec = {
  version: SPEC_VERSION,
  id: 'engine-preview',
  name: 'Two API servers behind a balancer, one database',
  description:
    'Steady traffic through a load balancer to two API servers backed by a single database. ' +
    'The client-to-balancer link drops 2% of packets and the database link is jittery.',
  seed: 'distlab-preview-1',
  durationMs: 10_000,
  nodes: [
    { id: 'client', type: 'client', label: 'Client' },
    { id: 'lb', type: 'load_balancer', label: 'Load balancer', config: { processing: 1 } },
    { id: 'api-1', type: 'api', label: 'API 1', config: { processing: 18, concurrency: 8 } },
    { id: 'api-2', type: 'api', label: 'API 2', config: { processing: 18, concurrency: 8 } },
    {
      id: 'db',
      type: 'database',
      label: 'Database',
      config: { readLatency: { kind: 'normal', mean: 14, stddev: 5 }, concurrency: 6, queueCapacity: 40 },
    },
  ],
  links: [
    { from: 'client', to: 'lb', latency: 8, lossRate: 0.02 },
    { from: 'lb', to: 'api-1', latency: 2 },
    { from: 'lb', to: 'api-2', latency: 2 },
    { from: 'api-1', to: 'db', latency: { kind: 'normal', mean: 4, stddev: 2 } },
    { from: 'api-2', to: 'db', latency: { kind: 'normal', mean: 4, stddev: 2 } },
  ],
  workloads: [
    {
      id: 'browse',
      clientId: 'client',
      operation: 'HTTP_GET',
      arrival: { kind: 'poisson', ratePerSec: 120 },
      deadlineMs: 800,
    },
  ],
};
