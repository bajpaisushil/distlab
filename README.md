# DistLab

A deterministic, event-driven laboratory for distributed systems that runs entirely in your browser.

**Live:** https://distlab.vercel.app

Draw an architecture, push traffic through it, break it on purpose, and read back exactly what
happened. Every number you see — latency percentiles, retries, stale reads, elections, lock
hand-offs — was produced by a discrete-event simulation. Nothing is an animation of what *might*
happen.

There is no backend, no account and nothing to pay for. Your scenarios stay in your browser.

## What you can do

**Design.** Drag components onto a canvas: clients, load balancers, gateways, API servers,
services, caches, databases and replicas, queues and workers, Raft nodes and lock services. Drag
from one node to another to connect them. Every node, link, workload and fault is editable in the
inspector. Undo and redo work everywhere.

**Run and rewind.** Play, pause, step one event at a time, step backwards, scrub the timeline, or
jump to any event and ask what the system looked like just before it. Change playback speed. The
same seed always produces the same run, event for event.

**Break things.** Faults are scheduled events, not visual effects, and everything after them
emerges from the simulation:

| Fault | What it does |
|---|---|
| Node crash | The process dies; in-memory work is lost |
| Link down | A cable is cut; the sender can tell |
| Network partition | Packets across the split vanish silently |
| Latency spike | A link gets slow without going down |
| Packet loss | A link drops a fraction of messages |
| Packet duplication | A link delivers some messages twice |
| Message delay | Everything to and from one host is held up |
| Process pause | A stop-the-world freeze; the node wakes believing no time passed |
| Overloaded node | Every unit of work takes longer |
| Unavailable | A database or queue refuses work and fails fast |
| Stale replica | A replica stops applying replication, then catches up |

**Explore the patterns.**

- *Load balancing:* first available, round robin, weighted, least connections, random,
  latency-aware (EWMA) and consistent hashing — each decision is logged with its reason.
- *Reliability:* per-call timeouts, retries with fixed or exponential backoff and full, equal
  or decorrelated jitter, circuit breakers (count or failure-rate, with half-open probes),
  bulkheads, and leader-hint redirects.
- *Data:* asynchronous and synchronous replication, read preferences, stale-read detection,
  in-order or naive replica apply, caches with TTL, LRU and miss coalescing, idempotent writes.
- *Messaging:* queues with backpressure, visibility timeouts, redelivery, dead-letter queues and
  duplicate processing.
- *Coordination:* a Raft-like cluster (terms, randomised elections, log replication, majority
  commit) and a lease-based lock service with fencing tokens. Both are simplified on purpose —
  for learning, not production.

**Observe.** Structured logs, metrics (throughput, p50/p95/p99, queue depth, utilisation,
retries, timeouts, drops, replication lag, and per-subsystem panels), and a waterfall for every
distributed trace (`traceId`, `spanId`, `parentSpanId`).

**Understand.** Select an event, a trace or a failed request and the Explain tab tells you why it
happened, built only from the events that caused it. Every fact says whether it was measured,
configured or derived, and links to the events behind it. Interpretation is labelled as such.

**Compare.** Run two architectures on the same workload and seed, or ask a what-if question
("traffic doubles", "turn on fencing tokens", "read from the primary") against your current
design. Differences come from the configuration, not from luck.

**Share.** Export and import `distlab-scenario.json`, or copy a share link that carries the whole
scenario in the URL. Your last session is restored from IndexedDB.

## Scenario library

| Category | Scenarios |
|---|---|
| Fundamentals | Basic load balancing · A web service, healthy |
| Failures | Node failure · Cascading failure · Retry storm · Circuit breaker |
| Network | Network partition · Packet loss and deadlines · Message reordering |
| Load | Capacity saturation · Thundering herd |
| Data | Database replication · Replica lag · Message duplication |
| Messaging | Queue overload · Dead-letter queue |
| Coordination | Leader election · Split brain · Distributed lock contention |

Each one states what it teaches and what to watch for, and has tests asserting that it really
shows it. For example, the retry-storm test checks that aggressive retries keep the system
overloaded after the trigger is gone while a circuit breaker lets it recover. The lock-contention
test checks that a frozen holder's late write is a safety violation without fencing and is refused
with it.

## Optional: ask Claude

The Explain tab has an optional section that uses your own Anthropic API key. It is off until you
press **Send**, and requests go from your browser straight to `api.anthropic.com` — DistLab has
no server in between.

- **What is sent:** a numbered evidence pack (the scenario's configuration, the simulator's own
  facts about what you selected, and headline metrics) plus your question. The Preview button
  shows exactly that text before anything leaves the browser.
- **What comes back** is structured JSON, checked before you see it. Every claim must cite the
  evidence it rests on; a number that is not in the cited evidence is flagged as unverified.
- **It cannot change the simulation.** A suggested experiment is validated like any hand-made
  change and opens in the What-if view for you to run. A drafted scenario is validated like an
  imported file — with one automatic correction round — and loads only if you choose.

It uses Claude Opus 5.5 by default (Sonnet 5.5 is available), with server-side refusal fallback
enabled. The key is kept in memory unless you tick *Remember on this device*.

## The one rule: determinism

A scenario plus a seed reproduces a run exactly — the same events, the same timings, the same ids.

- Virtual time only. The clock advances by processing events, never from `Date.now()` or a timer,
  so ten simulated seconds take milliseconds to compute.
- Every random decision comes from a seeded generator, split into independent per-link, per-node
  and per-module streams. Adding a link cannot change the dice another link rolls.
- Events are totally ordered by `(timestamp, sequence)`.
- Nodes never call each other. Every message travels through a simulated network that may delay,
  drop, duplicate, reorder or partition it.
- Every subsystem captures its state as plain data, so a run can be checkpointed and restored. A
  replay-equivalence test restores each subsystem mid-run and requires the identical outcome.

A [test](packages/simulation-engine/test/determinism-guard.test.ts) fails the build if
`Math.random`, `Date.now`, `setTimeout` or `new Date` appear in engine code.

## Layout

```
packages/shared              contracts: ids, virtual time, events, messages, node and link types,
                             scenario spec + validation, faults, per-subsystem protocols, seeded RNG
packages/network             latency, jitter, loss, duplication, reordering, bandwidth, partitions
packages/algorithms          pure cores: load balancing, backoff, circuit breaker, replication
                             ordering, queue delivery, Raft rules, lock table and fencing
packages/simulation-engine   kernel, node runtime, fault injector, replay, and the subsystem
                             modules (routing, data, queues, consensus, locks)
packages/telemetry           logs, metrics with exact percentiles, traces, per-subsystem telemetry
packages/scenarios           the scenario library, what-if experiments, run comparison
packages/ai                  grounded explanations; evidence packs and answer checks for Claude
apps/web                     Next.js app: canvas, inspector, playback, panels; the engine runs in a
                             Web Worker
```

Nothing in `packages/` imports React. The engine is tested in Node with no browser.

## Develop

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 434 unit and simulation tests
npm run test:e2e     # 10 Playwright tests against a production build
npm run typecheck
```

## Use the engine directly

```ts
import { createSimulation } from '@distlab/simulation-engine';

const world = createSimulation({
  version: 1,
  id: 'demo',
  name: 'API in front of a database',
  seed: 'demo-1',
  durationMs: 10_000,
  nodes: [
    { id: 'client', type: 'client' },
    { id: 'api', type: 'api', config: { processing: 18, concurrency: 8, callTimeoutMs: 300,
      retry: { maxRetries: 2, backoff: 'exponential', jitter: 'full' } } },
    { id: 'db', type: 'database', config: { readLatency: 14, concurrency: 6 } },
  ],
  links: [
    { from: 'client', to: 'api', latency: 8, lossRate: 0.02 },
    { from: 'api', to: 'db', latency: { kind: 'normal', mean: 4, stddev: 2 } },
  ],
  workloads: [
    { id: 'browse', clientId: 'client', operation: 'HTTP_GET',
      arrival: { kind: 'poisson', ratePerSec: 120 }, deadlineMs: 800 },
  ],
  faults: [{ kind: 'node_pause', at: 3000, nodeId: 'db', durationMs: 1500 }],
});

world.run();
const { latency, requests, modules } = world.snapshot();
console.log(requests.throughputPerSec, latency.p99, modules.reliability.retries);
```

## Privacy

The simulation runs locally. Scenarios are plain JSON; nothing is uploaded, and the app makes no
network calls of its own. The only exception is the optional Claude section, which sends what its
preview shows, to Anthropic, when you press Send.
