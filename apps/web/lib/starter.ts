import { SPEC_VERSION, type SimulationSpec } from '@distlab/shared';

/**
 * What the lab opens with when there is no shared link and no previous
 * session: small enough to read at a glance, busy enough to be interesting.
 */
export const STARTER_SCENARIO: SimulationSpec = {
  version: SPEC_VERSION,
  id: 'starter',
  name: 'Two API servers behind a balancer, one database',
  description:
    'Steady traffic through a load balancer to two API servers backed by a single database. ' +
    'The client-to-balancer link drops 2% of packets and the database link is jittery.',
  seed: 'distlab-starter',
  durationMs: 20_000,
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
  layout: {
    client: { x: 0, y: 0 },
    lb: { x: 260, y: 0 },
    'api-1': { x: 520, y: -90 },
    'api-2': { x: 520, y: 90 },
    db: { x: 780, y: 0 },
  },
  faults: [{ id: 'api-1-crash', kind: 'node_crash', at: 8000, nodeId: 'api-1', recoverAfter: 3000 }],
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
