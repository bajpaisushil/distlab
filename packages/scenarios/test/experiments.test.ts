import { describe, expect, it } from 'vitest';
import { createSimulation } from '@distlab/simulation-engine';
import { applyExperiment, compareSnapshots, describeChange, findScenario, verdictOf } from '../src/index.js';

const baseline = findScenario('web-service')!.spec;

function snapshotOf(spec: typeof baseline) {
  const world = createSimulation(spec);
  world.run();
  return world.snapshot();
}

describe('applyExperiment', () => {
  it('doubles traffic without touching the baseline', () => {
    const before = JSON.stringify(baseline);
    const result = applyExperiment(baseline, { name: 'Traffic doubles', changes: [{ kind: 'scale_traffic', factor: 2 }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variant.workloads[0]!.arrival).toEqual({ kind: 'poisson', ratePerSec: 240 });
    expect(result.variant.seed).toBe(baseline.seed);
    expect(JSON.stringify(baseline)).toBe(before);
  });

  it('makes the database slow', () => {
    const result = applyExperiment(baseline, {
      name: 'DB latency 2s',
      changes: [{ kind: 'set_node', nodeId: 'db', field: 'readLatency', value: 2000 }],
    });
    expect(result.ok && result.variant.nodes.find((n) => n.id === 'db')!.config!.readLatency).toBe(2000);
  });

  it('applies packet loss to every link and adds a crash', () => {
    const result = applyExperiment(baseline, {
      name: 'Lossy and broken',
      changes: [
        { kind: 'set_all_links', field: 'lossRate', value: 0.2 },
        { kind: 'add_fault', fault: { kind: 'node_crash', at: 3000, nodeId: 'api-2' } },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variant.links.every((l) => l.lossRate === 0.2)).toBe(true);
    expect(result.variant.faults).toHaveLength(1);
  });

  it('rejects changes that reference nothing or touch forbidden fields', () => {
    const result = applyExperiment(baseline, {
      name: 'Broken',
      changes: [
        { kind: 'set_node', nodeId: 'ghost', field: 'concurrency', value: 3 },
        { kind: 'set_node', nodeId: 'db', field: 'type', value: 'cache' },
        { kind: 'set_link', linkId: 'nope', field: 'latency', value: 1 },
        { kind: 'scale_traffic', factor: -1 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toEqual([
      'changes[0].nodeId',
      'changes[1].field',
      'changes[2].linkId',
      'changes[3].factor',
    ]);
  });

  it('surfaces a variant that no longer validates', () => {
    const result = applyExperiment(baseline, {
      name: 'Impossible',
      changes: [{ kind: 'set_all_links', field: 'lossRate', value: 3 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.path).toMatch(/^variant\.links/);
  });

  it('describes changes in words', () => {
    expect(describeChange({ kind: 'scale_traffic', factor: 2 })).toBe('traffic × 2');
    expect(describeChange({ kind: 'set_node', nodeId: 'db', field: 'readLatency', value: 2000 })).toBe('db.readLatency = 2000');
  });
});

describe('compareSnapshots', () => {
  it('measures what a slower database does, without declaring a winner overall', () => {
    const variant = applyExperiment(baseline, {
      name: 'Slow DB',
      changes: [{ kind: 'set_node', nodeId: 'db', field: 'readLatency', value: 120 }],
    });
    if (!variant.ok) throw new Error('variant invalid');
    const deltas = compareSnapshots(snapshotOf(baseline), snapshotOf(variant.variant));
    const p50 = deltas.find((d) => d.id === 'p50')!;
    expect(p50.b).toBeGreaterThan(p50.a + 90);
    expect(verdictOf(p50)).toBe('worse');
    // The same workload was offered to both.
    const created = deltas.find((d) => d.id === 'created')!;
    expect(created.a).toBe(created.b);
    expect(verdictOf(created)).toBe('same');
  });

  it('reports identical runs as identical', () => {
    const snapshot = snapshotOf(baseline);
    for (const delta of compareSnapshots(snapshot, snapshot)) expect(verdictOf(delta)).toBe('same');
  });
});
