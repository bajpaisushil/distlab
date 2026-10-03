import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/world.js';
import { chainScenario, constantLoad } from './helpers.js';

describe('metrics', () => {
  it('reports counts that reconcile with the event log', () => {
    const world = createSimulation(
      chainScenario({ durationMs: 5000, workloads: [constantLoad(20, { deadlineMs: 1000 })] }),
    );
    world.run();
    const snapshot = world.snapshot();
    const log = world.simulation.log;

    expect(snapshot.requests.created).toBe(log.byType('REQUEST_CREATED').length);
    expect(snapshot.requests.completed).toBe(log.byType('REQUEST_COMPLETED').length);
    expect(snapshot.requests.failed).toBe(log.byType('REQUEST_FAILED').length);
    expect(snapshot.messages.sent).toBe(log.byType('MESSAGE_SENT').length);
    expect(snapshot.messages.dropped).toBe(log.byType('MESSAGE_DROPPED').length);
    expect(snapshot.modules.data.reads).toBe(log.byType('DB_READ').length);
  });

  it('computes latency percentiles from the requests that actually completed', () => {
    const world = createSimulation(
      chainScenario({ durationMs: 3000, workloads: [constantLoad(20)] }),
    );
    world.run();
    const snapshot = world.snapshot();

    // Every hop is fixed, so every request takes exactly 86ms.
    expect(snapshot.latency.count).toBe(snapshot.requests.completed);
    expect(snapshot.latency.p50).toBe(86);
    expect(snapshot.latency.p99).toBe(86);
    expect(snapshot.latency.max).toBe(86);
  });

  it('separates the latency distribution when the system is impaired', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 5000,
        nodes: [
          { id: 'client', type: 'client' },
          { id: 'api', type: 'api', config: { processing: { kind: 'uniform', min: 5, max: 95 } } },
        ],
        links: [{ from: 'client', to: 'api', latency: 10 }],
        workloads: [constantLoad(50)],
      }),
    );
    world.run();
    const { latency } = world.snapshot();
    expect(latency.p50).toBeLessThan(latency.p95);
    expect(latency.p95).toBeLessThanOrEqual(latency.p99);
    expect(latency.p99).toBeLessThanOrEqual(latency.max);
    expect(latency.min).toBeGreaterThanOrEqual(25);
    expect(latency.max).toBeLessThanOrEqual(115);
  });

  it('attributes failures and drops to their reasons', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 3000,
        links: [
          { from: 'client', to: 'lb', latency: 10, lossRate: 1 },
          { from: 'lb', to: 'api', latency: 10 },
          { from: 'api', to: 'db', latency: 10 },
        ],
        workloads: [constantLoad(10, { deadlineMs: 300 })],
      }),
    );
    world.run();
    const snapshot = world.snapshot();

    expect(snapshot.failuresByReason).toEqual({ timeout: snapshot.requests.failed });
    expect(snapshot.messages.dropsByReason).toEqual({ packet_loss: snapshot.messages.dropped });
    expect(snapshot.requests.successRate).toBe(0);
    expect(snapshot.timeouts).toBeGreaterThan(0);
  });

  it('measures throughput over time rather than as a single average', () => {
    const world = createSimulation(
      chainScenario({ durationMs: 4000, workloads: [constantLoad(25, { stopAt: 2000 })] }),
    );
    world.run();
    const { throughput } = world.snapshot();

    const windows = new Map(throughput.completed.map((p) => [p.t, p.value]));
    // The first second is short: nothing can complete until the 86ms pipeline
    // has filled, so two of the 25 arrivals land in the next window.
    expect(windows.get(0)).toBe(23);
    // The second second is steady state, matching the 25/sec arrival rate.
    expect(windows.get(1000)).toBe(25);
    // Traffic stops at 2000, so the tail drains and then goes quiet.
    expect(windows.get(3000)).toBeUndefined();
  });

  it('reports per-node queue depth, utilisation and service time', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 2000,
        nodes: [
          { id: 'client', type: 'client' },
          { id: 'api', type: 'api', config: { processing: 40, concurrency: 1, queueCapacity: 50 } },
        ],
        links: [{ from: 'client', to: 'api', latency: 5 }],
        workloads: [constantLoad(50, { stopAt: 1000, deadlineMs: 5000 })],
      }),
    );
    world.run();

    const api = world.snapshot().nodes.find((n) => n.id === 'api');
    expect(api).toBeDefined();
    // Arrivals outpace a single 40ms worker, so a backlog has to build.
    expect(api!.maxQueueDepth).toBeGreaterThan(5);
    expect(api!.serviceTime.p50).toBe(40);
    expect(api!.utilization).toBeGreaterThan(0.9);
    expect(api!.utilization).toBeLessThanOrEqual(1);
  });

  it('reports zeroed metrics for a run with no traffic instead of NaN', () => {
    const world = createSimulation(chainScenario({ durationMs: 1000, workloads: [] }));
    world.run();
    const snapshot = world.snapshot();
    expect(snapshot.requests.created).toBe(0);
    expect(snapshot.requests.successRate).toBe(0);
    expect(snapshot.latency.p99).toBe(0);
    expect(Number.isNaN(snapshot.requests.throughputPerSec)).toBe(false);
  });
});

describe('traces', () => {
  it('builds one trace per request, with a span per hop', () => {
    const world = createSimulation(chainScenario());
    world.run();

    const traces = world.telemetry.traces.all();
    expect(traces).toHaveLength(1);

    const trace = traces[0]!;
    expect(trace.status).toBe('ok');
    expect(trace.duration).toBe(86);
    expect(trace.spans.map((s) => s.nodeId)).toEqual(['client', 'lb', 'api', 'db']);
    expect(trace.spans[0]?.kind).toBe('client');
    expect(trace.spans.slice(1).every((s) => s.kind === 'server')).toBe(true);
  });

  it('nests spans so each hop is the parent of the next', () => {
    const world = createSimulation(chainScenario());
    world.run();
    const spans = world.telemetry.traces.all()[0]!.spans;
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]?.parentSpanId).toBe(spans[i - 1]?.spanId);
    }
    expect(spans[0]?.parentSpanId).toBeUndefined();
  });

  it('makes network time visible as the gap between a parent and its child', () => {
    const world = createSimulation(chainScenario());
    world.run();
    const spans = world.telemetry.traces.all()[0]!.spans;

    // client span opens at 0, the LB's server span opens one 10ms hop later.
    expect(spans[1]!.startedAt - spans[0]!.startedAt).toBe(10);
    // LB spends 1ms processing, then a 10ms hop to the API.
    expect(spans[2]!.startedAt - spans[1]!.startedAt).toBe(11);
    // Each span encloses its child.
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.startedAt).toBeGreaterThanOrEqual(spans[i - 1]!.startedAt);
      expect(spans[i]!.endedAt!).toBeLessThanOrEqual(spans[i - 1]!.endedAt!);
    }
  });

  it('closes spans that were abandoned when a request timed out', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 2000,
        links: [
          { from: 'client', to: 'lb', latency: 10 },
          { from: 'lb', to: 'api', latency: 10, lossRate: 1 },
          { from: 'api', to: 'db', latency: 10 },
        ],
        workloads: [
          {
            id: 'w',
            clientId: 'client',
            operation: 'HTTP_GET',
            arrival: { kind: 'once', count: 1 },
            deadlineMs: 400,
          },
        ],
      }),
    );
    world.run();

    const trace = world.telemetry.traces.all()[0]!;
    expect(trace.status).toBe('timeout');
    expect(trace.spans.every((s) => s.status !== 'open')).toBe(true);
    expect(trace.spans.every((s) => s.endedAt !== undefined)).toBe(true);
    expect(trace.duration).toBe(400);
  });

  it('surfaces the slowest and the failed traces', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 3000,
        nodes: [
          { id: 'client', type: 'client' },
          { id: 'api', type: 'api', config: { processing: { kind: 'uniform', min: 5, max: 200 } } },
        ],
        links: [{ from: 'client', to: 'api', latency: 5 }],
        workloads: [constantLoad(30, { deadlineMs: 150 })],
      }),
    );
    world.run();

    const slowest = world.telemetry.traces.slowest(5);
    expect(slowest).toHaveLength(5);
    for (let i = 1; i < slowest.length; i++) {
      expect(slowest[i - 1]!.duration!).toBeGreaterThanOrEqual(slowest[i]!.duration!);
    }
    const failed = world.telemetry.traces.failed();
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((t) => t.status === 'timeout')).toBe(true);
  });
});

describe('logs', () => {
  it('writes a line per processed event, describing it from its payload', () => {
    const world = createSimulation(chainScenario());
    world.run();
    expect(world.telemetry.logs.all()).toHaveLength(world.simulation.log.size);

    const completion = world.telemetry.logs
      .all()
      .find((r) => r.eventType === 'REQUEST_COMPLETED');
    expect(completion?.message).toMatch(/completed in 86ms via client -> lb -> api -> db/);
  });

  it('raises the level for events that lose work', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 1500,
        links: [
          { from: 'client', to: 'lb', latency: 10, lossRate: 1 },
          { from: 'lb', to: 'api', latency: 10 },
          { from: 'api', to: 'db', latency: 10 },
        ],
        workloads: [constantLoad(10, { deadlineMs: 300 })],
      }),
    );
    world.run();

    const errors = world.telemetry.logs.atLeast('error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((r) => r.eventType === 'REQUEST_FAILED')).toBe(true);
    expect(world.telemetry.logs.atLeast('warn').some((r) => r.eventType === 'MESSAGE_DROPPED')).toBe(true);
  });

  it('filters logs down to a single trace', () => {
    const world = createSimulation(
      chainScenario({ durationMs: 1000, workloads: [constantLoad(10)] }),
    );
    world.run();
    const trace = world.telemetry.traces.all()[0]!;
    const lines = world.telemetry.logs.forTrace(trace.traceId);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.every((r) => r.traceId === trace.traceId)).toBe(true);
  });
});

describe('telemetry is a passive observer', () => {
  it('produces identical simulation results with tracing on and off', () => {
    const fingerprint = (captureTraces: boolean) => {
      const world = createSimulation(
        chainScenario({
          seed: 'observer',
          durationMs: 3000,
          links: [
            { from: 'client', to: 'lb', latency: { kind: 'normal', mean: 10, stddev: 3 } },
            { from: 'lb', to: 'api', latency: 10, lossRate: 0.1 },
            { from: 'api', to: 'db', latency: 10 },
          ],
          workloads: [
            { id: 'p', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 30 } },
          ],
        }),
        { telemetry: { captureTraces } },
      );
      world.run();
      return world.simulation.log.all().map((e) => `${e.at}|${e.type}|${e.id}`);
    };
    expect(fingerprint(true)).toEqual(fingerprint(false));
  });
});
