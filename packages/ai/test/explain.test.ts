import { describe, expect, it } from 'vitest';
import { SPEC_VERSION, resolveSimulationSpec, type SimEvent, type SimulationSpec } from '@distlab/shared';
import { createSimulation } from '@distlab/simulation-engine';
import { REQUEST_CONTEXT_TYPES, explainArchitecture, explainEvent, explainRequest } from '../src/index.js';

const base = (overrides: Partial<SimulationSpec> = {}): SimulationSpec => ({
  version: SPEC_VERSION,
  id: 'explain',
  name: 'Explain',
  seed: 'explain',
  durationMs: 3000,
  nodes: [
    { id: 'client', type: 'client' },
    { id: 'lb', type: 'load_balancer', config: { processing: 1 } },
    { id: 'api', type: 'api', config: { processing: 15 } },
    { id: 'db', type: 'database', config: { readLatency: 10 } },
  ],
  links: [
    { from: 'client', to: 'lb', latency: 10 },
    { from: 'lb', to: 'api', latency: 10 },
    { from: 'api', to: 'db', latency: 10 },
  ],
  workloads: [{ id: 'w', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'once', count: 1 }, deadlineMs: 400 }],
  ...overrides,
});

function evidenceFor(spec: SimulationSpec, pick: (e: SimEvent) => boolean) {
  const world = createSimulation(spec);
  world.run();
  const log = world.simulation.log.all();
  const outcome = log.find(pick)!;
  const traceId = outcome.traceId!;
  const events = log.filter((e) => e.traceId === traceId);
  const first = events[0]!.at;
  const last = events[events.length - 1]!.at;
  const context = log.filter((e) => REQUEST_CONTEXT_TYPES.includes(e.type) && e.at >= first && e.at <= last);
  return { events, context, spec: resolveSimulationSpec(spec), world };
}

describe('explainRequest', () => {
  it('breaks a successful request into network, processing and queueing time', () => {
    const evidence = evidenceFor(base(), (e) => e.type === 'REQUEST_COMPLETED');
    const explanation = explainRequest(evidence);
    expect(explanation.title).toMatch(/completed in 86/);
    expect(explanation.summary).toMatch(/60.0ms on the network, 26.0ms processing and 0.00ms queued/);
    // Every measured fact cites at least one event.
    for (const fact of explanation.facts.filter((f) => f.kind === 'measured')) expect(fact.eventIds.length).toBeGreaterThan(0);
  });

  it('blames a lost message for a timeout, citing the drop and the link configuration', () => {
    const spec = base({
      links: [
        { from: 'client', to: 'lb', latency: 10 },
        { from: 'lb', to: 'api', latency: 10, lossRate: 1 },
        { from: 'api', to: 'db', latency: 10 },
      ],
    });
    const evidence = evidenceFor(spec, (e) => e.type === 'REQUEST_FAILED');
    const explanation = explainRequest(evidence);
    expect(explanation.title).toMatch(/timeout/);
    expect(explanation.summary).toMatch(/packet loss between Load balancer|packet loss between lb/);
    const drop = evidence.events.find((e) => e.type === 'MESSAGE_DROPPED')!;
    expect(explanation.facts.some((f) => f.eventIds.includes(drop.id))).toBe(true);
    expect(explanation.facts.some((f) => f.kind === 'configured' && /lose 100%/.test(f.text))).toBe(true);
  });

  it('blames a crash for a timeout when a node on the path died', () => {
    const spec = base({
      nodes: [
        { id: 'client', type: 'client' },
        { id: 'api', type: 'api', config: { processing: 200 } },
      ],
      links: [{ from: 'client', to: 'api', latency: 10 }],
      faults: [{ kind: 'node_crash', at: 50, nodeId: 'api' }],
    });
    const explanation = explainRequest(evidenceFor(spec, (e) => e.type === 'REQUEST_FAILED'));
    expect(explanation.summary).toMatch(/api crashed at t=50/);
  });

  it('explains a rejection with the node configuration that caused it', () => {
    const spec = base({
      nodes: [
        { id: 'client', type: 'client' },
        { id: 'api', type: 'api', config: { processing: 100, concurrency: 1, queueCapacity: 0 } },
      ],
      links: [{ from: 'client', to: 'api', latency: 5 }],
      workloads: [{ id: 'w', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'once', count: 2 }, deadlineMs: 400 }],
    });
    const explanation = explainRequest(evidenceFor(spec, (e) => e.type === 'REQUEST_FAILED'));
    expect(explanation.summary).toMatch(/full/);
    expect(explanation.facts.some((f) => f.kind === 'configured' && /1 requests at once and queues at most 0/.test(f.text))).toBe(true);
  });
});

describe('explainEvent', () => {
  it('walks the causal chain back to its root', () => {
    const spec = base({ faults: [{ kind: 'node_crash', at: 1000, nodeId: 'api', recoverAfter: 100 }] });
    const world = createSimulation(spec);
    world.run();
    const failed = world.simulation.log.byType('NODE_FAILED')[0]!;
    const chain = world.simulation.log.causalChain(failed.id);
    const explanation = explainEvent({
      event: failed,
      chain,
      effects: world.simulation.log.all().filter((e) => e.causedBy === failed.id),
      nodesBefore: world.registry.snapshot(0),
      spec: resolveSimulationSpec(spec),
    });
    expect(explanation.summary).toMatch(/traces back through 2 steps to simulation started/);
    expect(explanation.facts.map((f) => f.eventIds[0])).toEqual(expect.arrayContaining(chain.map((e) => e.id)));
  });
});

describe('explainArchitecture', () => {
  it('finds paths, single points of failure and a latency floor', () => {
    const explanation = explainArchitecture(resolveSimulationSpec(base()));
    expect(explanation.facts.some((f) => /Client → Load balancer|client → lb/.test(f.text))).toBe(true);
    expect(explanation.facts.some((f) => /Single points of failure/.test(f.text))).toBe(true);
    // 3 links × 10ms × 2 directions + 1 + 15 + 25 processing (database default processing).
    expect(explanation.facts.some((f) => /about 101ms at best/.test(f.text))).toBe(true);
    expect(explanation.facts.every((f) => f.kind !== 'measured')).toBe(true);
  });

  it('reports no single point of failure when every tier is redundant', () => {
    const spec = base({
      nodes: [
        { id: 'client', type: 'client' },
        { id: 'a', type: 'api' },
        { id: 'b', type: 'api' },
      ],
      links: [
        { from: 'client', to: 'a' },
        { from: 'client', to: 'b' },
      ],
    });
    expect(explainArchitecture(resolveSimulationSpec(spec)).facts.some((f) => /No single node failure/.test(f.text))).toBe(true);
  });

  it('predicts a bottleneck from configured capacity and offered load', () => {
    const spec = base({
      nodes: [
        { id: 'client', type: 'client' },
        { id: 'api', type: 'api', config: { processing: 100, concurrency: 2 } },
      ],
      links: [{ from: 'client', to: 'api' }],
      workloads: [{ id: 'w', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 19 } }],
    });
    const explanation = explainArchitecture(resolveSimulationSpec(spec));
    expect(explanation.facts.some((f) => /likely bottlenecks are api at ~95% of 20 req\/s/.test(f.text))).toBe(true);
  });
});
