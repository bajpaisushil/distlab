import { SPEC_VERSION, type SimulationSpec } from '@distlab/shared';

export type ScenarioCategory = 'Fundamentals' | 'Failures' | 'Network' | 'Load' | 'Data' | 'Messaging' | 'Coordination';

export interface Scenario {
  readonly spec: SimulationSpec;
  readonly category: ScenarioCategory;
  readonly difficulty: 'intro' | 'intermediate' | 'advanced';
}

type Draft = Omit<SimulationSpec, 'version'> & { category: ScenarioCategory; difficulty: Scenario['difficulty'] };

function scenario({ category, difficulty, ...spec }: Draft): Scenario {
  return { spec: { version: SPEC_VERSION, ...spec, category }, category, difficulty };
}

const webTier = {
  nodes: [
    { id: 'client', type: 'client' as const, label: 'Clients' },
    { id: 'lb', type: 'load_balancer' as const, label: 'Load balancer', config: { processing: 1 } },
    { id: 'api-1', type: 'api' as const, label: 'API 1', config: { processing: 18, concurrency: 8 } },
    { id: 'api-2', type: 'api' as const, label: 'API 2', config: { processing: 18, concurrency: 8 } },
    {
      id: 'db',
      type: 'database' as const,
      label: 'Database',
      config: { readLatency: { kind: 'normal' as const, mean: 14, stddev: 5 }, concurrency: 8, queueCapacity: 64 },
    },
  ],
  links: [
    { from: 'client', to: 'lb', latency: 8 },
    { from: 'lb', to: 'api-1', latency: 2 },
    { from: 'lb', to: 'api-2', latency: 2 },
    { from: 'api-1', to: 'db', latency: { kind: 'normal' as const, mean: 4, stddev: 1.5 } },
    { from: 'api-2', to: 'db', latency: { kind: 'normal' as const, mean: 4, stddev: 1.5 } },
  ],
  layout: {
    client: { x: 0, y: 0 },
    lb: { x: 260, y: 0 },
    'api-1': { x: 520, y: -100 },
    'api-2': { x: 520, y: 100 },
    db: { x: 800, y: 0 },
  },
};

export const SCENARIOS: readonly Scenario[] = [
  scenario({
    id: 'web-service',
    name: 'A web service, healthy',
    description:
      'Steady traffic through a load balancer to two API servers and a database. Nothing is broken — this is the baseline every other scenario departs from.',
    category: 'Fundamentals',
    difficulty: 'intro',
    seed: 'web-service',
    durationMs: 15_000,
    ...webTier,
    workloads: [{ id: 'browse', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 120 }, deadlineMs: 800 }],
    learningObjectives: [
      'End-to-end latency is the sum of every network crossing and every processing step on the path.',
      'Poisson arrivals clump: even a healthy system sees short bursts of queueing.',
      'p99 sits well above p50 even with nothing broken — tails come from variance, not failure.',
    ],
    observe: ['the gap between p50 and p99', 'utilisation of each tier', 'the waterfall of a slow trace'],
  }),
  scenario({
    id: 'node-failure',
    name: 'Node failure',
    description:
      'One API server crashes five seconds in and comes back six seconds later. Requests it was holding are lost; the load balancer routes around it while it is down.',
    category: 'Failures',
    difficulty: 'intro',
    seed: 'node-failure',
    durationMs: 16_000,
    ...webTier,
    workloads: [{ id: 'browse', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 100 }, deadlineMs: 600 }],
    faults: [{ id: 'api-1-crash', kind: 'node_crash', at: 5000, nodeId: 'api-1', recoverAfter: 6000, reason: 'kernel panic' }],
    learningObjectives: [
      'A crash loses the work in memory: requests in flight at the crash time out at the client.',
      'Requests that arrive after the crash are routed to the surviving instance — redundancy hides the failure from them.',
      'A crash is silent: nothing tells the caller, which is why every request needs a deadline.',
    ],
    observe: ['the failure spike right at 5s', 'traffic shifting to API 2', 'recovery at 11s'],
  }),
  scenario({
    id: 'network-partition',
    name: 'Network partition',
    description:
      'The network splits the front end from the back end for four seconds. Unlike a crash or a cut cable, nothing on either side can tell — packets simply vanish.',
    category: 'Network',
    difficulty: 'intermediate',
    seed: 'network-partition',
    durationMs: 14_000,
    nodes: [
      { id: 'client', type: 'client', label: 'Clients' },
      { id: 'lb', type: 'load_balancer', label: 'Load balancer', config: { processing: 1 } },
      { id: 'api', type: 'api', label: 'API', config: { processing: 15, concurrency: 16 } },
      { id: 'db', type: 'database', label: 'Database', config: { readLatency: 12, concurrency: 8 } },
    ],
    links: [
      { from: 'client', to: 'lb', latency: 8 },
      { from: 'lb', to: 'api', latency: 3 },
      { from: 'api', to: 'db', latency: 4 },
    ],
    layout: { client: { x: 0, y: 0 }, lb: { x: 260, y: 0 }, api: { x: 520, y: 0 }, db: { x: 780, y: 0 } },
    workloads: [{ id: 'browse', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 60 }, deadlineMs: 700 }],
    faults: [{ id: 'split', kind: 'partition', at: 5000, groups: [['client', 'lb'], ['api', 'db']], healAfter: 4000 }],
    learningObjectives: [
      'In a partition, messages are dropped silently: senders only learn by waiting out their deadline.',
      'Every request during the partition costs the full deadline, so latency jumps to exactly the timeout.',
      'Compare with a link-down fault, where the sender sees the failure immediately and fails fast.',
    ],
    observe: ['drops with reason "partitioned"', 'failed requests taking exactly 700ms', 'instant recovery when the partition heals'],
  }),
  scenario({
    id: 'packet-loss',
    name: 'Packet loss and deadlines',
    description:
      'The link to the API tier loses 4% of packets. Each loss is invisible to the sender, so one dropped message costs a request its entire deadline.',
    category: 'Network',
    difficulty: 'intro',
    seed: 'packet-loss',
    durationMs: 12_000,
    ...webTier,
    links: webTier.links.map((l) => (l.from === 'lb' ? { ...l, lossRate: 0.04 } : l)),
    workloads: [{ id: 'browse', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 80 }, deadlineMs: 500 }],
    learningObjectives: [
      'A request crosses a lossy link twice (request and response), so its failure rate is roughly twice the loss rate.',
      'Losses show up as timeouts at exactly the deadline, not as fast errors.',
      'p99 latency collapses onto the deadline once more than 1% of requests are lost.',
    ],
    observe: ['failure rate ≈ 2 × loss rate', 'p99 pinned at 500ms', 'the explanation of a failed request'],
  }),
  scenario({
    id: 'capacity-saturation',
    name: 'Capacity saturation',
    description:
      'One API server can handle about 80 requests a second. Traffic starts at 60/s; at 6s a second wave pushes it to 140/s. Watch utilisation, then queueing, then rejections.',
    category: 'Load',
    difficulty: 'intermediate',
    seed: 'capacity-saturation',
    durationMs: 14_000,
    nodes: [
      { id: 'client', type: 'client', label: 'Clients' },
      { id: 'api', type: 'api', label: 'API', config: { processing: { kind: 'exponential', mean: 50 }, concurrency: 4, queueCapacity: 40 } },
    ],
    links: [{ from: 'client', to: 'api', latency: 5 }],
    layout: { client: { x: 0, y: 0 }, api: { x: 300, y: 0 } },
    workloads: [
      { id: 'base', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 60 }, deadlineMs: 2000 },
      { id: 'surge', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 80 }, deadlineMs: 2000, startAt: 6000, stopAt: 10_000 },
    ],
    learningObjectives: [
      'Below capacity, latency is mostly service time; near capacity, waiting dominates and grows non-linearly.',
      'Past capacity a queue grows without bound — a finite queue turns that into rejections instead.',
      'Rejecting early (backpressure) keeps latency bounded for the requests that are admitted.',
    ],
    observe: ['queue depth during the surge', 'p95 climbing before any request fails', 'rejections once the queue is full'],
  }),
  scenario({
    id: 'cascading-failure',
    name: 'Cascading failure',
    description:
      'The database does not crash — it just gets slow. API servers hold a worker slot for every request waiting on it, run out of slots, queue, then reject. A slow dependency takes down the healthy tier in front of it.',
    category: 'Failures',
    difficulty: 'advanced',
    seed: 'cascading-failure',
    durationMs: 16_000,
    ...webTier,
    nodes: webTier.nodes.map((n) =>
      n.type === 'api' ? { ...n, config: { processing: 10, concurrency: 6, queueCapacity: 20 } } : n,
    ),
    workloads: [{ id: 'browse', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 150 }, deadlineMs: 1200 }],
    faults: [
      { id: 'db-slow-1', kind: 'latency_spike', at: 5000, linkId: 'api-1->db', latency: 250, durationMs: 5000 },
      { id: 'db-slow-2', kind: 'latency_spike', at: 5000, linkId: 'api-2->db', latency: 250, durationMs: 5000 },
    ],
    learningObjectives: [
      'Slow is worse than dead: a dead dependency fails fast, a slow one holds every caller’s resources.',
      'API servers that are themselves perfectly healthy saturate because their workers are all waiting.',
      'Failures move upstream — the client sees rejections from the API tier, not from the database.',
    ],
    observe: ['API utilisation jumping although its own processing time is unchanged', 'rejections at the APIs', 'how long recovery takes after 10s'],
  }),
  scenario({
    id: 'message-duplication',
    name: 'Message duplication',
    description:
      'The network delivers 15% of messages twice. The API has no idempotency, so duplicated requests are processed twice — the client asked once and got one answer, but the work happened twice.',
    category: 'Network',
    difficulty: 'intermediate',
    seed: 'message-duplication',
    durationMs: 10_000,
    nodes: [
      { id: 'client', type: 'client', label: 'Clients' },
      { id: 'api', type: 'api', label: 'Payments API', config: { processing: 12, concurrency: 16 } },
    ],
    links: [{ from: 'client', to: 'api', latency: 10, duplicateRate: 0.15 }],
    layout: { client: { x: 0, y: 0 }, api: { x: 320, y: 0 } },
    workloads: [{ id: 'charges', clientId: 'client', operation: 'HTTP_POST', arrival: { kind: 'poisson', ratePerSec: 40 }, deadlineMs: 1000 }],
    learningObjectives: [
      'Networks can deliver a message more than once; "exactly once" is something applications build, not something they get.',
      'The client sees one response per request — duplicates are invisible from the outside.',
      'Without idempotency, side effects (a charge, a write) happen once per delivery.',
    ],
    observe: ['API "served" count exceeding requests issued', 'duplicate markers on in-flight messages', 'spans marked (dup) in traces'],
  }),
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.spec.id === id);
}
