import { describe, expect, it } from 'vitest';
import { validateSimulationSpec, type SimulationSpec } from '@distlab/shared';
import {
  addFault,
  addLink,
  addNode,
  addWorkload,
  emptySpec,
  moveNode,
  removeFault,
  removeLink,
  removeNode,
  sameSimulation,
  uniqueId,
  updateFault,
  updateLink,
  updateNode,
  updateWorkload,
} from '../lib/spec-edit';
import { autoLayout } from '../lib/layout';
import { decodeSpec, encodeSpec } from '../lib/share';

function built(): SimulationSpec {
  let spec = emptySpec();
  for (const type of ['client', 'load_balancer', 'api', 'api', 'database'] as const) spec = addNode(spec, type).spec;
  spec = addLink(spec, 'client', 'lb')!.spec;
  spec = addLink(spec, 'lb', 'api')!.spec;
  spec = addLink(spec, 'lb', 'api-2')!.spec;
  spec = addLink(spec, 'api', 'db')!.spec;
  spec = addLink(spec, 'api-2', 'db')!.spec;
  return spec;
}

describe('spec editing', () => {
  it('builds a valid architecture from scratch', () => {
    const spec = built();
    expect(validateSimulationSpec(spec)).toEqual({ valid: true, errors: [] });
    expect(spec.nodes.map((n) => n.id)).toEqual(['client', 'lb', 'api', 'api-2', 'db']);
    expect(spec.nodes.map((n) => n.label)).toEqual(['Client', 'Load balancer', 'API server', 'API server 2', 'Database']);
    // A new client comes with traffic so it does something.
    expect(spec.workloads.map((w) => w.clientId)).toEqual(['client']);
  });

  it('refuses self-links and duplicate links in either direction', () => {
    const spec = built();
    expect(addLink(spec, 'lb', 'lb')).toBeUndefined();
    expect(addLink(spec, 'lb', 'api')).toBeUndefined();
    expect(addLink(spec, 'api', 'lb')).toBeUndefined();
  });

  it('cascades a node removal to its links, workloads and faults', () => {
    let spec = built();
    spec = addFault(spec, { kind: 'node_crash', at: 1000, nodeId: 'api' }).spec;
    spec = addFault(spec, { kind: 'link_down', at: 1000, linkId: 'lb->api' }).spec;
    spec = addFault(spec, { kind: 'partition', at: 1000, groups: [['client', 'lb'], ['api'], ['db']] }).spec;
    spec = removeNode(spec, 'api');
    expect(spec.nodes.map((n) => n.id)).not.toContain('api');
    expect(spec.links.some((l) => l.from === 'api' || l.to === 'api')).toBe(false);
    expect(spec.faults?.map((f) => f.kind)).toEqual(['partition']);
    expect(validateSimulationSpec(spec).valid).toBe(true);

    expect(removeNode(spec, 'client').workloads).toHaveLength(0);
  });

  it('drops a partition that no longer has two sides', () => {
    let spec = built();
    spec = addFault(spec, { kind: 'partition', at: 1, groups: [['client'], ['db']] }).spec;
    expect(removeNode(spec, 'db').faults).toHaveLength(0);
  });

  it('merges node config one level deep and deletes undefined keys', () => {
    let spec = updateNode(built(), 'api', { config: { processing: 40, concurrency: 4 } });
    spec = updateNode(spec, 'api', { config: { concurrency: undefined }, label: 'Primary API' });
    const api = spec.nodes.find((n) => n.id === 'api')!;
    expect(api.config).toEqual({ processing: 40 });
    expect(api.label).toBe('Primary API');
  });

  it('edits and removes links, taking their faults with them', () => {
    let spec = updateLink(built(), 'lb->api', { lossRate: 0.1, latency: 30 });
    expect(spec.links.find((l) => l.id === 'lb->api')).toMatchObject({ lossRate: 0.1, latency: 30 });
    spec = addFault(spec, { kind: 'packet_loss', at: 5, linkId: 'lb->api', lossRate: 1 }).spec;
    spec = removeLink(spec, 'lb->api');
    expect(spec.links.map((l) => l.id)).not.toContain('lb->api');
    expect(spec.faults).toHaveLength(0);
  });

  it('adds and edits workloads', () => {
    let { spec, id } = addWorkload(built(), 'client');
    spec = updateWorkload(spec, id, { arrival: { kind: 'constant', ratePerSec: 5 }, maxRequests: 3 });
    expect(spec.workloads.find((w) => w.id === id)).toMatchObject({ maxRequests: 3, arrival: { kind: 'constant' } });
    expect(validateSimulationSpec(spec).valid).toBe(true);
  });

  it('gives faults stable ids and edits them by id', () => {
    let spec = built();
    const first = addFault(spec, { kind: 'node_crash', at: 1000, nodeId: 'api' });
    const second = addFault(first.spec, { kind: 'node_crash', at: 2000, nodeId: 'db' });
    expect(first.id).not.toBe(second.id);
    spec = updateFault(second.spec, first.id, { recoverAfter: 500 });
    expect(spec.faults?.find((f) => f.id === first.id)).toMatchObject({ recoverAfter: 500 });
    spec = removeFault(spec, second.id);
    expect(spec.faults?.map((f) => f.id)).toEqual([first.id]);
  });

  it('treats a layout change as presentation only', () => {
    const spec = built();
    expect(sameSimulation(spec, moveNode(spec, 'api', { x: 10, y: 20 }))).toBe(true);
    expect(sameSimulation(spec, updateLink(spec, 'lb->api', { latency: 99 }))).toBe(false);
  });

  it('generates unique ids', () => {
    expect(uniqueId('api', ['api', 'api-2'])).toBe('api-3');
    expect(uniqueId('db', [])).toBe('db');
  });
});

describe('auto layout', () => {
  it('lays traffic out left to right by distance from the clients', () => {
    const layout = autoLayout(built());
    expect(layout.client!.x).toBeLessThan(layout.lb!.x);
    expect(layout.lb!.x).toBeLessThan(layout.api!.x);
    expect(layout.api!.x).toBe(layout['api-2']!.x);
    expect(layout.api!.y).not.toBe(layout['api-2']!.y);
    expect(layout.api!.x).toBeLessThan(layout.db!.x);
  });

  it('keeps positions the scenario already set', () => {
    const spec = moveNode(built(), 'db', { x: 999, y: 999 });
    expect(autoLayout(spec).db).toEqual({ x: 999, y: 999 });
  });
});

describe('share links', () => {
  it('round-trips a scenario through a compressed URL token', async () => {
    const spec = built();
    const token = await encodeSpec(spec);
    expect(token.startsWith('z.')).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9._-]+$/);
    const decoded = await decodeSpec(token);
    expect('spec' in decoded && decoded.spec).toEqual(spec);
  });

  it('rejects a damaged token without throwing', async () => {
    const decoded = await decodeSpec('z.not-really-deflate');
    expect('errors' in decoded).toBe(true);
  });
});
