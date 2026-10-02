# DistLab

A deterministic simulation engine for distributed systems, running entirely in the browser.

DistLab lets you build an architecture, push traffic through it, break things, and read back
exactly what happened — logs, metrics and traces produced by a real event-driven simulation
rather than by animations on a diagram.

**Status: phases 1–3 of 12.** The engine, the simulated network and the telemetry layer are
built and tested. The visual editor, failure injection, consensus algorithms, replay and the AI
explanation layer are not. The [development order](#development-order) below tracks what is done.

## The one rule

A scenario plus a seed reproduces a run exactly — the same events, the same timings, the same
event ids. Everything else is built on that:

- Virtual time only. The clock advances by processing events, never from `Date.now()` or a timer,
  so a 10-second simulation finishes in about 150ms and 10,000 events cost nothing to replay.
- Every random decision comes from a seeded generator, split into independent per-link and
  per-node streams. Adding a link cannot change the dice another link rolls.
- Events are totally ordered by `(timestamp, sequence)`. Ties never fall to heap layout.
- Nodes never call each other. Every hop goes through a simulated network that may delay, drop,
  duplicate, reorder or partition it.

A [test](packages/simulation-engine/test/determinism-guard.test.ts) fails the build if
`Math.random`, `Date.now`, `setTimeout` or `new Date` ever appear in engine code.

## Layout

```
packages/shared              contracts: ids, virtual time, the event union and its typed
                             payloads, message/node/link types, scenario spec + validator, RNG
packages/network             latency, jitter, packet loss, duplication, reordering,
                             bandwidth, link outages, partitions
packages/telemetry           structured logs, metrics with exact percentiles, distributed traces
packages/simulation-engine   clock, event queue, kernel, node runtime, composition root
apps/web                     a minimal Next.js page that runs a scenario in the browser
```

`network` and `telemetry` depend only on `shared`, and reach the kernel through a `SimulationContext`
interface. The graph is acyclic and nothing in `packages/` imports React — the engine is tested in
Node with no browser and no DOM.

## Try it

```bash
npm install
npm test          # 157 tests across the four packages
npm run typecheck
npm run dev       # http://localhost:3000
```

## Using the engine

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
    { id: 'api', type: 'api', config: { processing: 18, concurrency: 8 } },
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
});

world.run();
const { latency, requests } = world.snapshot();
console.log(requests.throughputPerSec, latency.p99);
```

Crash a node partway through — failures are scheduled events, not a side channel:

```ts
world.start();
world.simulation.scheduleAt({ type: 'NODE_FAILED', payload: { nodeId: 'api', reason: 'oom' } }, 3000);
world.run();
```

Step rather than run, which is what the UI will do:

```ts
world.step();                       // exactly one event
world.run({ maxEvents: 500 });      // a batch, then yield
world.simulation.runUntil((e) => e.type === 'REQUEST_FAILED');
```

## What the model does today

**Nodes** hold a bounded worker pool. A request occupies a slot from admission until the node
answers, *including* time spent waiting on a downstream call, so thread-pool exhaustion and
backpressure emerge on their own. Arrivals that find every worker busy queue; arrivals that find
the queue full are rejected.

**Requests** carry a deadline that every hop honours. Without it a dropped message would leave a
request pending forever and error rates would be undefined. Retries, backoff, configurable
per-call timeouts and circuit breakers are phase 7 — this is the floor that stops the system
leaking capacity, not the reliability stack.

**Traces** are derived from message events rather than declared by nodes: a server span opens when
a node receives a request and closes when it sends the reply, so the gap between a parent span and
its child *is* the network time.

**Metrics** are computed only from events the engine processed. There is no path for a number to
exist that the simulation did not produce — which is the property the later AI layer depends on.

## Development order

| | Phase |
|---|---|
| ✅ | 1 · Simulation clock, event queue, deterministic RNG |
| ✅ | 2 · Nodes, simulated network, messages |
| ✅ | 3 · Request tracing and metrics |
| ◻ | 4 · Architecture canvas |
| ◻ | 5 · Failure injection |
| ◻ | 6 · Load balancing and replication |
| ◻ | 7 · Queues, retries, circuit breakers |
| ◻ | 8 · Leader election and distributed locks |
| ◻ | 9 · Time travel and replay |
| ◻ | 10 · Scenario library |
| ◻ | 11 · Architecture comparison and what-if experiments |
| ◻ | 12 · AI copilot |

Each phase lands with tests before the next one starts. Event types, node types and config fields
for unbuilt phases are deliberately absent: a name in the type system with no handler behind it is
a lie the compiler will happily tell you.

### Seams already in place

- `DownstreamSelector` ([routing.ts](packages/simulation-engine/src/routing.ts)) is where phase 6's
  round-robin, weighted, least-connections and latency-aware strategies plug in. Today there is one
  implementation, `first-available`, which makes the absence of a real strategy visible in the
  metrics instead of hiding it behind accidental round-robin.
- `NODE_FAILED` / `NODE_RECOVERED` are ordinary scheduled events, so phase 5's fault injector is a
  scheduler on top of what already works.
- The event log records every processed event with a `causedBy` chain, which is the substrate
  phase 9's replay will rewind.

## Privacy

The simulation is local. Scenarios are plain JSON you can export and import, nothing is sent
anywhere, and the engine has no network calls of its own. When the AI layer arrives it will be
opt-in per analysis and will receive only structured simulation state.
