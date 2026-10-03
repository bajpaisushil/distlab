import { SPEC_VERSION, type LinkSpec, type NodeSpec, type SimulationSpec, type WorkloadSpec } from '@distlab/shared';

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

/** A five-node Raft cluster in a ring layout; n1 times out first, so it wins the first election. */
function raftCluster(): { nodes: NodeSpec[]; links: LinkSpec[]; layout: Record<string, { x: number; y: number }> } {
  const members = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const nodes: NodeSpec[] = members.map((id, i) => ({
    id,
    type: 'consensus',
    label: `Node ${i + 1}`,
    config: { processing: 2, consensus: { electionTimeoutMs: i === 0 ? { min: 60, max: 80 } : { min: 150, max: 300 }, heartbeatIntervalMs: 40 } },
  }));
  const links: LinkSpec[] = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) links.push({ from: members[i]!, to: members[j]!, latency: { kind: 'uniform', min: 3, max: 8 } });
  }
  const layout: Record<string, { x: number; y: number }> = {};
  // Node 1 at the bottom, then clockwise: nodes 1 and 2 sit nearest the lower clients.
  members.forEach((id, i) => {
    const angle = Math.PI / 2 + (i / members.length) * Math.PI * 2;
    layout[id] = { x: 780 + Math.round(Math.cos(angle) * 220), y: 30 + Math.round(Math.sin(angle) * 220) };
  });
  return { nodes, links, layout };
}

/** A client and a balancer that tries the next node when one says it is not the leader. */
function raftClient(prefix: string, targets: readonly string[], rate: number, y: number) {
  const client = `${prefix}client`;
  const lb = `${prefix}lb`;
  return {
    nodes: [
      { id: client, type: 'client', label: prefix ? `Clients ${prefix.replace('-', '').toUpperCase()}` : 'Clients' },
      {
        id: lb,
        type: 'load_balancer',
        label: prefix ? `Router ${prefix.replace('-', '').toUpperCase()}` : 'Router',
        config: {
          processing: 1,
          callTimeoutMs: 250,
          // Back off a little: during an election nobody is leader, and retrying instantly just burns attempts.
          retry: { maxRetries: 5, backoff: 'exponential', baseDelayMs: 25, maxDelayMs: 200, jitter: 'full', retryOn: ['not_leader', 'timeout', 'unreachable'] },
        },
      },
    ] as NodeSpec[],
    links: [{ from: client, to: lb, latency: 3 }, ...targets.map((t) => ({ from: lb, to: t, latency: 3 }))] as LinkSpec[],
    layout: { [client]: { x: 40, y }, [lb]: { x: 320, y } },
    workloads: [
      { id: `${prefix}writes`, clientId: client, operation: 'HTTP_POST', arrival: { kind: 'poisson', ratePerSec: rate }, deadlineMs: 1500, startAt: 300 },
    ] as WorkloadSpec[],
  };
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
    id: 'load-balancing',
    name: 'Basic load balancing',
    description:
      'A load balancer spreads traffic over three API servers — but API 3 runs on older hardware and is three times slower. Round robin treats them equally. Switch the balancer to least connections or latency-aware and watch API 3’s share fall.',
    category: 'Fundamentals',
    difficulty: 'intro',
    seed: 'load-balancing',
    durationMs: 15_000,
    nodes: [
      { id: 'client', type: 'client', label: 'Clients' },
      { id: 'lb', type: 'load_balancer', label: 'Load balancer', config: { processing: 1, routing: 'round_robin' } },
      { id: 'api-1', type: 'api', label: 'API 1', config: { processing: { kind: 'exponential', mean: 15 }, concurrency: 8 } },
      { id: 'api-2', type: 'api', label: 'API 2', config: { processing: { kind: 'exponential', mean: 15 }, concurrency: 8 } },
      { id: 'api-3', type: 'api', label: 'API 3 (old hardware)', config: { processing: { kind: 'exponential', mean: 45 }, concurrency: 8 } },
    ],
    links: [
      { from: 'client', to: 'lb', latency: 5 },
      { from: 'lb', to: 'api-1', latency: 2 },
      { from: 'lb', to: 'api-2', latency: 2 },
      { from: 'lb', to: 'api-3', latency: 2 },
    ],
    layout: {
      client: { x: 0, y: 0 },
      lb: { x: 260, y: 0 },
      'api-1': { x: 540, y: -150 },
      'api-2': { x: 540, y: 0 },
      'api-3': { x: 540, y: 150 },
    },
    workloads: [{ id: 'browse', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 300 }, deadlineMs: 1500 }],
    learningObjectives: [
      'Round robin gives every server the same share, so the slowest one sets the tail latency.',
      'Least connections and latency-aware routing send less to a slow server without being told which one it is.',
      'Weighted round robin works too — but only if you know the capacities in advance and they never change.',
    ],
    observe: ['the balancer’s distribution chart in Metrics', 'p99 latency', 'API 3’s utilisation compared with the others'],
  }),
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
    id: 'retry-storm',
    name: 'Retry storm',
    description:
      'A database runs at 80% of capacity. At 3s it slows down for one second — a blip. Clients retry aggressively: each slow attempt is abandoned and retried, but the abandoned work stays in the database’s queue. The blip never ends.',
    category: 'Failures',
    difficulty: 'advanced',
    seed: 'retry-storm',
    durationMs: 14_000,
    nodes: [
      {
        id: 'client',
        type: 'client',
        label: 'Clients (retry ×5, no backoff)',
        config: { callTimeoutMs: 200, retry: { maxRetries: 5, backoff: 'none' } },
      },
      { id: 'api', type: 'api', label: 'API', config: { processing: 2, concurrency: 200, queueCapacity: 400 } },
      { id: 'db', type: 'database', label: 'Database', config: { readLatency: 40, concurrency: 4, queueCapacity: 300 } },
    ],
    links: [
      { from: 'client', to: 'api', latency: 5 },
      { from: 'api', to: 'db', latency: 2 },
    ],
    layout: { client: { x: 0, y: 0 }, api: { x: 300, y: 0 }, db: { x: 600, y: 0 } },
    workloads: [{ id: 'reads', clientId: 'client', operation: 'DB_READ', arrival: { kind: 'poisson', ratePerSec: 80 }, deadlineMs: 3000 }],
    faults: [{ id: 'blip', kind: 'latency_spike', at: 3000, linkId: 'api->db', latency: 400, durationMs: 1000 }],
    learningObjectives: [
      'Retries multiply load exactly when a dependency can least afford it.',
      'An abandoned attempt is not free: the work it started keeps consuming the dependency’s capacity.',
      'A one-second trigger becomes a permanent outage — a metastable failure. Remove the trigger and the system still does not recover.',
      'Backoff and jitter alone do not fix it here; shedding load (a circuit breaker) does. Try it in What-if.',
    ],
    observe: ['success rate after 4s, when the blip is over', 'retries per second', 'the database’s queue pinned at capacity'],
  }),
  scenario({
    id: 'circuit-breaker',
    name: 'Circuit breaker',
    description:
      'The API loses its database for three seconds behind a network partition. Its circuit breaker opens after five failures, fails fast instead of waiting, probes after each cooldown, and closes once the database answers again.',
    category: 'Failures',
    difficulty: 'intermediate',
    seed: 'circuit-breaker',
    durationMs: 10_000,
    nodes: [
      { id: 'client', type: 'client', label: 'Clients' },
      {
        id: 'api',
        type: 'api',
        label: 'API (breaker)',
        config: { processing: 2, callTimeoutMs: 200, circuitBreaker: { failureThreshold: 5, cooldownMs: 1000 } },
      },
      { id: 'db', type: 'database', label: 'Database', config: { readLatency: 10 } },
    ],
    links: [
      { from: 'client', to: 'api', latency: 5 },
      { from: 'api', to: 'db', latency: 5 },
    ],
    layout: { client: { x: 0, y: 0 }, api: { x: 300, y: 0 }, db: { x: 600, y: 0 } },
    workloads: [{ id: 'reads', clientId: 'client', operation: 'DB_READ', arrival: { kind: 'constant', ratePerSec: 50 }, deadlineMs: 1500 }],
    faults: [{ id: 'split', kind: 'partition', at: 2000, groups: [['api'], ['db']], healAfter: 3000 }],
    learningObjectives: [
      'Without a breaker, every request during the outage would wait out its timeout; with one, they fail in milliseconds.',
      'Failing fast protects the caller’s capacity and gives the dependency room to recover.',
      'Half-open probes test the water with one request instead of releasing the whole flood at once.',
    ],
    observe: ['the circuit state chart in Metrics', 'failed requests taking ~10ms instead of 200ms', 'the single successful probe that closes the circuit'],
  }),
  scenario({
    id: 'message-duplication',
    name: 'Message duplication',
    description:
      'A payments API records charges in a ledger database. The link between them delivers 15% of messages twice. The ledger is not idempotent, so a duplicated write is a second charge — the customer asked once and was billed twice.',
    category: 'Network',
    difficulty: 'intermediate',
    seed: 'message-duplication',
    durationMs: 10_000,
    nodes: [
      { id: 'client', type: 'client', label: 'Checkout' },
      { id: 'api', type: 'api', label: 'Payments API', config: { processing: 8, concurrency: 16 } },
      { id: 'ledger', type: 'database', label: 'Ledger', config: { writeLatency: 15, idempotentWrites: false } },
    ],
    links: [
      { from: 'client', to: 'api', latency: 10 },
      { from: 'api', to: 'ledger', latency: 5, duplicateRate: 0.15 },
    ],
    layout: { client: { x: 0, y: 0 }, api: { x: 300, y: 0 }, ledger: { x: 600, y: 0 } },
    workloads: [{ id: 'charges', clientId: 'client', operation: 'DB_WRITE', arrival: { kind: 'poisson', ratePerSec: 40 }, keys: 1000, deadlineMs: 1000 }],
    learningObjectives: [
      'Networks can deliver a message more than once; "exactly once" is something applications build, not something they get.',
      'The client sees one response per request — duplicates are invisible from the outside, and only the ledger shows the damage.',
      'An idempotency key (here, the request id) turns at-least-once delivery into effectively-once processing. Try it in What-if.',
    ],
    observe: ['“writes applied twice” in Metrics', 'DUPLICATE_WRITE_APPLIED events', 'duplicate markers on in-flight messages'],
  }),
  scenario({
    id: 'database-replication',
    name: 'Database replication',
    description:
      'Writes go to a primary, which copies them to two read replicas a few tens of milliseconds later. Reads are spread over all three. Replicas take load off the primary — at the price of sometimes answering with data that is a moment out of date.',
    category: 'Data',
    difficulty: 'intro',
    seed: 'database-replication',
    durationMs: 15_000,
    nodes: [
      { id: 'client', type: 'client', label: 'Clients' },
      { id: 'api', type: 'api', label: 'API', config: { processing: 5, concurrency: 32, readPreference: 'any' } },
      { id: 'db', type: 'database', label: 'Primary', config: { readLatency: 8, writeLatency: 15, concurrency: 8 } },
      { id: 'replica-a', type: 'replica', label: 'Replica A', config: { replicaOf: 'db', readLatency: 8, replicationDelay: { kind: 'normal', mean: 30, stddev: 10 } } },
      { id: 'replica-b', type: 'replica', label: 'Replica B', config: { replicaOf: 'db', readLatency: 8, replicationDelay: { kind: 'normal', mean: 30, stddev: 10 } } },
    ],
    links: [
      { from: 'client', to: 'api', latency: 5 },
      { from: 'api', to: 'db', latency: 2 },
      { from: 'api', to: 'replica-a', latency: 2 },
      { from: 'api', to: 'replica-b', latency: 2 },
      { from: 'db', to: 'replica-a', latency: 5 },
      { from: 'db', to: 'replica-b', latency: 5 },
    ],
    layout: {
      client: { x: 0, y: 0 },
      api: { x: 280, y: 0 },
      db: { x: 580, y: 0 },
      'replica-a': { x: 860, y: -120 },
      'replica-b': { x: 860, y: 120 },
    },
    workloads: [
      {
        id: 'app',
        clientId: 'client',
        operation: 'DB_READ',
        mix: [
          { operation: 'DB_READ', weight: 8 },
          { operation: 'DB_WRITE', weight: 2 },
        ],
        arrival: { kind: 'poisson', ratePerSec: 300 },
        keys: 20,
        deadlineMs: 1000,
      },
    ],
    learningObjectives: [
      'All writes go to the primary; replicas receive them as a stream of log records over the network.',
      'Reading from replicas spreads load — the primary handles far fewer reads.',
      'Asynchronous replication means a replica can answer before it has seen the latest write: a stale read.',
    ],
    observe: ['storage load across the three databases', 'the replication lag chart', 'stale reads by replica'],
  }),
  scenario({
    id: 'replica-lag',
    name: 'Replica lag',
    description:
      'The same system, but Replica B is in another region and applies records about 400ms late, and reads go to replicas only. A user writes, then reads straight back — and often does not see their own write.',
    category: 'Data',
    difficulty: 'intermediate',
    seed: 'replica-lag',
    durationMs: 15_000,
    nodes: [
      { id: 'client', type: 'client', label: 'Clients' },
      { id: 'api', type: 'api', label: 'API', config: { processing: 5, concurrency: 32, readPreference: 'replica' } },
      { id: 'db', type: 'database', label: 'Primary', config: { readLatency: 8, writeLatency: 15, concurrency: 8 } },
      { id: 'replica-a', type: 'replica', label: 'Replica A (same region)', config: { replicaOf: 'db', readLatency: 8, replicationDelay: 20 } },
      {
        id: 'replica-b',
        type: 'replica',
        label: 'Replica B (far away)',
        config: { replicaOf: 'db', readLatency: 8, replicationDelay: { kind: 'normal', mean: 400, stddev: 100 } },
      },
    ],
    links: [
      { from: 'client', to: 'api', latency: 5 },
      { from: 'api', to: 'db', latency: 2 },
      { from: 'api', to: 'replica-a', latency: 2 },
      { from: 'api', to: 'replica-b', latency: 2 },
      { from: 'db', to: 'replica-a', latency: 5 },
      { from: 'db', to: 'replica-b', latency: 60 },
    ],
    layout: {
      client: { x: 0, y: 0 },
      api: { x: 280, y: 0 },
      db: { x: 580, y: 0 },
      'replica-a': { x: 860, y: -120 },
      'replica-b': { x: 860, y: 120 },
    },
    workloads: [
      {
        id: 'app',
        clientId: 'client',
        operation: 'DB_READ',
        mix: [
          { operation: 'DB_READ', weight: 7 },
          { operation: 'DB_WRITE', weight: 3 },
        ],
        arrival: { kind: 'poisson', ratePerSec: 300 },
        keys: 10,
        hotKeyShare: 0.3,
        deadlineMs: 1000,
      },
    ],
    learningObjectives: [
      'Staleness grows with lag: a replica 400ms behind serves stale data for every key written in the last 400ms.',
      'Eventual consistency means replicas converge — not that a read reflects the latest write.',
      'Fixes trade off differently: read from the primary (no staleness, all load on one node) or replicate synchronously (no stale acknowledged writes, slower writes). Compare them in What-if.',
    ],
    observe: ['stale reads concentrated on Replica B', 'its lag line far above Replica A’s', 'what happens with reads from the primary'],
  }),
  scenario({
    id: 'message-reordering',
    name: 'Message reordering',
    description:
      'The replication link reorders 30% of records. The replica applies records in the order they arrive rather than in log order, so a late, older write can overwrite a newer one — the replica rolls data backwards.',
    category: 'Network',
    difficulty: 'advanced',
    seed: 'message-reordering',
    durationMs: 12_000,
    nodes: [
      { id: 'client', type: 'client', label: 'Clients' },
      { id: 'api', type: 'api', label: 'API', config: { processing: 4, readPreference: 'replica' } },
      { id: 'db', type: 'database', label: 'Primary', config: { writeLatency: 10 } },
      { id: 'replica', type: 'replica', label: 'Replica (arrival-order apply)', config: { replicaOf: 'db', replicaApply: 'arrival', replicationDelay: 0 } },
    ],
    links: [
      { from: 'client', to: 'api', latency: 5 },
      { from: 'api', to: 'db', latency: 2 },
      { from: 'api', to: 'replica', latency: 2 },
      { from: 'db', to: 'replica', latency: 15, reorderRate: 0.3, reorderDelay: { kind: 'uniform', min: 20, max: 200 } },
    ],
    layout: { client: { x: 0, y: 0 }, api: { x: 280, y: 0 }, db: { x: 560, y: -90 }, replica: { x: 560, y: 110 } },
    workloads: [
      {
        id: 'app',
        clientId: 'client',
        operation: 'DB_READ',
        mix: [
          { operation: 'DB_READ', weight: 1 },
          { operation: 'DB_WRITE', weight: 1 },
        ],
        arrival: { kind: 'poisson', ratePerSec: 150 },
        keys: 4,
        deadlineMs: 1000,
      },
    ],
    learningObjectives: [
      'Networks do not preserve order: a message sent later can arrive first.',
      'Applying updates in arrival order lets an old value overwrite a new one — data goes back in time.',
      'Numbering updates (log sequence numbers) and applying them in order makes the replica converge regardless of reordering. Switch the replica to log order in What-if.',
    ],
    observe: ['VERSION_REGRESSION events', '“version regressions” in Metrics', 'reordered messages overtaking each other on the replication link'],
  }),
  scenario({
    id: 'thundering-herd',
    name: 'Thundering herd',
    description:
      'Almost all traffic reads one hot key through a cache. Every time that key expires, hundreds of requests miss at the same instant and stampede the database together — a latency spike every two seconds, like clockwork.',
    category: 'Load',
    difficulty: 'intermediate',
    seed: 'thundering-herd',
    durationMs: 12_000,
    nodes: [
      { id: 'client', type: 'client', label: 'Clients' },
      {
        id: 'cache',
        type: 'cache',
        label: 'Cache',
        config: { processing: 1, concurrency: 1024, queueCapacity: 2048, cache: { ttlMs: 2000, coalesce: false } },
      },
      { id: 'db', type: 'database', label: 'Database', config: { readLatency: 30, concurrency: 4, queueCapacity: 500 } },
    ],
    links: [
      { from: 'client', to: 'cache', latency: 3 },
      { from: 'cache', to: 'db', latency: 5 },
    ],
    layout: { client: { x: 0, y: 0 }, cache: { x: 300, y: 0 }, db: { x: 600, y: 0 } },
    workloads: [{ id: 'hot', clientId: 'client', operation: 'DB_READ', arrival: { kind: 'poisson', ratePerSec: 800 }, keys: 50, hotKeyShare: 0.9, deadlineMs: 2000 }],
    learningObjectives: [
      'A popular key expiring sends every concurrent request for it to the database at once.',
      'The database sees periodic bursts far above its capacity even though the average load is tiny.',
      'Request coalescing (single-flight) lets one request refill the key while the rest wait for it. Turn it on in What-if.',
    ],
    observe: ['the sawtooth in the database’s queue', 'p99 spiking every 2s', 'the cache hit ratio dipping at each expiry'],
  }),
  scenario({
    id: 'queue-overload',
    name: 'Queue overload',
    description:
      'Orders arrive faster than two workers can process them. The queue absorbs the difference — for a while. Depth climbs, every order waits longer, and once the queue is full the producer starts getting refusals.',
    category: 'Messaging',
    difficulty: 'intro',
    seed: 'queue-overload',
    durationMs: 20_000,
    nodes: [
      { id: 'shop', type: 'client', label: 'Shop (producer)' },
      { id: 'orders', type: 'queue', label: 'Orders queue', config: { queue: { capacity: 200, visibilityTimeoutMs: 5000 } } },
      { id: 'worker-1', type: 'worker', label: 'Worker 1', config: { processing: { kind: 'exponential', mean: 80 }, concurrency: 2 } },
      { id: 'worker-2', type: 'worker', label: 'Worker 2', config: { processing: { kind: 'exponential', mean: 80 }, concurrency: 2 } },
    ],
    links: [
      { from: 'shop', to: 'orders', latency: 5 },
      { from: 'orders', to: 'worker-1', latency: 2 },
      { from: 'orders', to: 'worker-2', latency: 2 },
    ],
    layout: { shop: { x: 0, y: 0 }, orders: { x: 300, y: 0 }, 'worker-1': { x: 600, y: -90 }, 'worker-2': { x: 600, y: 90 } },
    workloads: [
      { id: 'orders', clientId: 'shop', operation: 'ENQUEUE', arrival: { kind: 'poisson', ratePerSec: 40 }, deadlineMs: 1000, stopAt: 2000 },
      { id: 'sale', clientId: 'shop', operation: 'ENQUEUE', arrival: { kind: 'poisson', ratePerSec: 75 }, deadlineMs: 1000, startAt: 2000, stopAt: 14_000 },
    ],
    learningObjectives: [
      'A queue decouples producers from consumers: producers get an instant acknowledgement however slow processing is.',
      'If arrivals outpace consumers, depth grows without bound — and so does the time every item waits.',
      'A bounded queue turns overload into refusals the producer can see (backpressure) instead of unbounded delay.',
      'Adding consumers raises throughput; try a third worker and watch the depth fall.',
    ],
    observe: ['queue depth climbing during the sale', 'consumer lag growing with it', 'refusals once 200 items are held'],
  }),
  scenario({
    id: 'dead-letter-queue',
    name: 'Dead-letter queue',
    description:
      'One in twenty messages is malformed and can never be processed. Each fails, is redelivered, and fails again — until, after three attempts, it is moved to a dead-letter queue so it stops consuming worker time.',
    category: 'Messaging',
    difficulty: 'intermediate',
    seed: 'dead-letter-queue',
    durationMs: 15_000,
    nodes: [
      { id: 'producer', type: 'client', label: 'Producer' },
      {
        id: 'jobs',
        type: 'queue',
        label: 'Jobs queue',
        config: { queue: { capacity: 500, maxDeliveries: 3, visibilityTimeoutMs: 2000, redeliveryDelayMs: 200, poisonRate: 0.05, deadLetterQueue: 'dlq' } },
      },
      { id: 'worker-1', type: 'worker', label: 'Worker 1', config: { processing: 40, concurrency: 2 } },
      { id: 'worker-2', type: 'worker', label: 'Worker 2', config: { processing: 40, concurrency: 2 } },
      { id: 'dlq', type: 'queue', label: 'Dead letters', config: { queue: { capacity: 10_000 } } },
    ],
    links: [
      { from: 'producer', to: 'jobs', latency: 5 },
      { from: 'jobs', to: 'worker-1', latency: 2 },
      { from: 'jobs', to: 'worker-2', latency: 2 },
      { from: 'jobs', to: 'dlq', latency: 2 },
    ],
    layout: {
      producer: { x: 0, y: 0 },
      jobs: { x: 300, y: 0 },
      'worker-1': { x: 600, y: -110 },
      'worker-2': { x: 600, y: 40 },
      dlq: { x: 600, y: 200 },
    },
    workloads: [{ id: 'jobs', clientId: 'producer', operation: 'ENQUEUE', arrival: { kind: 'poisson', ratePerSec: 60 }, deadlineMs: 1000 }],
    learningObjectives: [
      'A poison message fails every time; without a limit it would be retried forever and waste capacity.',
      'Bounded redelivery plus a dead-letter queue isolates bad messages for inspection without blocking good ones.',
      'Redelivery is how at-least-once delivery recovers from worker crashes — the same mechanism that causes duplicates.',
    ],
    observe: ['QUEUE_DEAD_LETTERED events, each after exactly 3 attempts', 'the dead-letter queue’s depth', 'redeliveries in Metrics'],
  }),
  (() => {
    const raft = raftCluster();
    const clients = raftClient('', ['n1', 'n2', 'n3', 'n4', 'n5'], 40, 30);
    return scenario({
      id: 'leader-election',
      name: 'Leader election',
      description:
        'Five nodes run a Raft-like protocol (an educational simulation, not production Raft). Node 1 leads until it crashes at 4s. The followers stop hearing heartbeats, time out at random moments, and elect a new leader in a higher term; writes stall only for the election.',
      category: 'Coordination',
      difficulty: 'intermediate',
      seed: 'leader-election',
      durationMs: 12_000,
      nodes: [...raft.nodes, ...clients.nodes],
      links: [...raft.links, ...clients.links],
      layout: { ...raft.layout, ...clients.layout },
      workloads: clients.workloads,
      faults: [{ id: 'leader-crash', kind: 'node_crash', at: 4000, nodeId: 'n1', recoverAfter: 5000 }],
      learningObjectives: [
        'A leader proves it is alive with heartbeats; silence for a randomised election timeout triggers an election.',
        'Each election starts a new term; a node votes at most once per term, so at most one leader can win it.',
        'A write is acknowledged only after a majority holds it, so the new leader already has every acknowledged write.',
        'A recovered old leader rejoins as a follower: it sees a higher term and defers.',
      ],
      observe: ['the leadership strip in Metrics', 'the term rising at the crash', 'the brief gap in completed writes during the election'],
    });
  })(),
  (() => {
    const raft = raftCluster();
    const majority = raftClient('a-', ['n1', 'n2', 'n3', 'n4', 'n5'], 30, -130);
    const minority = raftClient('b-', ['n1', 'n2', 'n3', 'n4', 'n5'], 20, 190);
    return scenario({
      id: 'split-brain',
      name: 'Split brain',
      description:
        'A partition cuts the leader and one follower off from the other three, with some clients on each side. Both sides end up with a node that believes it leads — but only the side with a majority can commit anything. When the network heals, the old leader learns it was replaced and steps down.',
      category: 'Coordination',
      difficulty: 'advanced',
      seed: 'split-brain',
      durationMs: 12_000,
      nodes: [...raft.nodes, ...majority.nodes, ...minority.nodes],
      links: [...raft.links, ...majority.links, ...minority.links],
      layout: { ...raft.layout, ...majority.layout, ...minority.layout },
      workloads: [...majority.workloads, ...minority.workloads],
      faults: [
        {
          id: 'split',
          kind: 'partition',
          at: 3000,
          groups: [
            ['n1', 'n2', 'b-client', 'b-lb'],
            ['n3', 'n4', 'n5', 'a-client', 'a-lb'],
          ],
          healAfter: 4000,
        },
      ],
      learningObjectives: [
        'In a partition, both sides can have a node that believes it is leader — split brain, at least in belief.',
        'Majority quorums make it harmless: the minority leader cannot get a majority to acknowledge anything, so it commits nothing and its clients’ writes time out.',
        'Terms resolve it: on healing, the old leader sees a higher term and steps down without a fight.',
        'Systems without quorums (or fencing) let both sides accept writes — compare the lock contention scenario.',
      ],
      observe: ['the “Split brain · 2 leaders” tile in Metrics', 'side B’s writes all failing during the partition', 'the STEPPED_DOWN event at 7s'],
    });
  })(),
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.spec.id === id);
}
