import { describe, expect, it } from 'vitest';
import { SPEC_VERSION, type SimEvent, type SimulationSpec } from '@distlab/shared';
import { createSimulation } from '@distlab/simulation-engine';
import { LabSession, runToCompletion } from '../lib/engine/session';

const spec = (overrides: Partial<SimulationSpec> = {}): SimulationSpec => ({
  version: SPEC_VERSION,
  id: 'session-test',
  name: 'Session test',
  seed: 'session',
  durationMs: 4000,
  nodes: [
    { id: 'client', type: 'client' },
    { id: 'api', type: 'api', config: { processing: { kind: 'uniform', min: 5, max: 25 } } },
    { id: 'db', type: 'database' },
  ],
  links: [
    { from: 'client', to: 'api', latency: 10, lossRate: 0.02 },
    { from: 'api', to: 'db', latency: 5 },
  ],
  workloads: [
    { id: 'w', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 60 }, deadlineMs: 500 },
  ],
  faults: [{ kind: 'node_crash', at: 1500, nodeId: 'db', recoverAfter: 500 }],
  ...overrides,
});

function loaded(s = spec()): LabSession {
  const session = new LabSession();
  const result = session.load(s, false);
  expect(result.ok).toBe(true);
  return session;
}

describe('LabSession', () => {
  it('reports validation issues instead of loading a broken spec', () => {
    const session = new LabSession();
    const result = session.load(spec({ links: [{ from: 'client', to: 'ghost' }] }), false);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((i) => i.path)).toContain('links[0].to');
    expect(session.loaded).toBe(false);
  });

  it('starts at position zero with the topology in the frame', () => {
    const frame = loaded().frame(false, 1);
    expect(frame.position).toBe(0);
    expect(frame.now).toBe(0);
    expect(frame.nodes.map((n) => n.id)).toEqual(['client', 'api', 'db']);
    expect(frame.links.map((l) => l.id)).toEqual(['client->api', 'api->db']);
    expect(frame.links[0]?.meanLatency).toBe(10);
  });

  it('plays in frame-sized slices to the same result as a plain run', () => {
    const session = loaded();
    while (!session.completed) session.advance(16 * 3, 5_000);
    const plain = createSimulation(spec());
    plain.run();
    expect(session.frame(false, 1).snapshot).toEqual(plain.snapshot());
  });

  it('honours the per-frame event budget', () => {
    const session = loaded();
    const processed = session.advance(4000, 50);
    expect(processed).toBeGreaterThanOrEqual(50);
    expect(processed).toBeLessThan(2000);
    expect(session.now).toBeLessThan(4000);
  });

  it('keeps virtual time across an edit', () => {
    const session = loaded();
    session.seekTime(1234);
    expect(session.now).toBe(1234);
    session.load(spec({ seed: 'edited' }), true);
    expect(session.now).toBe(1234);
  });

  it('seeks by virtual time to the last event at or before it', () => {
    const session = loaded();
    session.toEnd();
    session.seekTime(2000);
    const frame = session.frame(false, 1);
    expect(frame.now).toBe(2000);
    expect(frame.recent.at(-1)!.at).toBeLessThanOrEqual(2000);
    const all = session.query({ kind: 'events', filter: { upToCurrent: false }, offset: 0, limit: 1_000_000 });
    expect(frame.position).toBe(all.items.filter((e) => e.at <= 2000).length);
  });

  it('steps and steps back', () => {
    const session = loaded();
    session.step(100);
    expect(session.frame(false, 1).position).toBe(100);
    session.back(40);
    expect(session.frame(false, 1).position).toBe(60);
  });

  it('shows messages on the wire mid-run', () => {
    const session = loaded();
    session.seekTime(1000);
    const frame = session.frame(true, 1);
    expect(frame.inFlightTotal).toBeGreaterThan(0);
    for (const message of frame.inFlight) {
      expect(message.sentAt).toBeLessThanOrEqual(frame.now);
      expect(message.deliverAt).toBeGreaterThanOrEqual(frame.now);
    }
  });

  it('flags faults and failures on the timeline', () => {
    const session = loaded();
    session.toEnd();
    const kinds = session.frame(false, 1).markers.map((m) => m.kind);
    expect(kinds).toContain('fault');
    expect(kinds).toContain('failure');
    expect(kinds).toContain('recovery');
  });

  it('pages and filters events', () => {
    const session = loaded();
    session.toEnd();
    const failures = session.query({ kind: 'events', filter: { types: ['REQUEST_FAILED'] }, offset: 0, limit: 5 });
    expect(failures.total).toBeGreaterThan(0);
    expect(failures.items.length).toBeLessThanOrEqual(5);
    expect(failures.items.every((e) => e.type === 'REQUEST_FAILED')).toBe(true);

    const atDb = session.query({ kind: 'events', filter: { nodeId: 'db' }, offset: 0, limit: 50 });
    expect(atDb.items.every((e) => e.nodeId === 'db')).toBe(true);
  });

  it('filters logs by level', () => {
    const session = loaded();
    session.toEnd();
    const errors = session.query({ kind: 'logs', filter: { minLevel: 'error' }, offset: 0, limit: 100 });
    expect(errors.total).toBeGreaterThan(0);
    expect(errors.items.every((r) => r.level === 'error')).toBe(true);
  });

  it('explains an event: its causes, its effects and the state just before it', () => {
    const session = loaded();
    session.toEnd();
    const failed = session.query({ kind: 'events', filter: { types: ['NODE_FAILED'] }, offset: 0, limit: 1 }).items[0] as SimEvent;
    const detail = session.query({ kind: 'eventDetail', eventId: failed.id });
    expect(detail).not.toBeNull();
    expect(detail!.chain.map((e) => e.type)).toEqual(['SIMULATION_STARTED', 'FAULT_INJECTED', 'NODE_FAILED']);
    expect(detail!.nodesBefore.find((n) => n.id === 'db')?.status).toBe('healthy');
    expect(detail!.description).toMatch(/db failed/);
  });

  it('lists the slowest traces', () => {
    const session = loaded();
    session.toEnd();
    const traces = session.query({ kind: 'traces', sort: 'slowest', limit: 3 });
    expect(traces).toHaveLength(3);
    expect(traces[0]!.duration!).toBeGreaterThanOrEqual(traces[2]!.duration!);
  });

  it('runs a separate spec to completion for comparisons', () => {
    const summary = runToCompletion(spec());
    const plain = createSimulation(spec());
    plain.run();
    expect(summary.snapshot).toEqual(plain.snapshot());
    expect(summary.events).toBe(plain.simulation.eventsProcessed);
  });
});
