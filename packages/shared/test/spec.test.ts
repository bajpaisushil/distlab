import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REQUEST_DEADLINE_MS,
  SPEC_VERSION,
  parseSimulationSpec,
  resolveSimulationSpec,
  serializeSimulationSpec,
  validateSimulationSpec,
  type SimulationSpec,
} from '@distlab/shared';

const valid = (): SimulationSpec => ({
  version: SPEC_VERSION,
  id: 'scenario-1',
  name: 'Basic chain',
  seed: 'abc',
  nodes: [
    { id: 'client', type: 'client' },
    { id: 'api', type: 'api' },
    { id: 'db', type: 'database' },
  ],
  links: [
    { from: 'client', to: 'api' },
    { from: 'api', to: 'db', latency: 20, lossRate: 0.01 },
  ],
  workloads: [
    { id: 'w', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'constant', ratePerSec: 10 } },
  ],
});

const errorPaths = (spec: unknown) => validateSimulationSpec(spec).errors.map((e) => e.path);

describe('validateSimulationSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(validateSimulationSpec(valid())).toEqual({ valid: true, errors: [] });
  });

  it('rejects anything that is not an object', () => {
    for (const input of [null, 42, 'spec', undefined]) {
      expect(validateSimulationSpec(input).valid).toBe(false);
    }
  });

  it('rejects an unsupported version', () => {
    expect(errorPaths({ ...valid(), version: 99 })).toContain('version');
  });

  it('rejects duplicate node ids', () => {
    const spec = valid();
    spec.nodes.push({ id: 'api', type: 'service' });
    expect(errorPaths(spec)).toContain('nodes[3].id');
  });

  it('rejects an unknown node type', () => {
    const spec = valid();
    spec.nodes[1] = { id: 'api', type: 'quantum' as never };
    expect(errorPaths(spec)).toContain('nodes[1].type');
  });

  it('rejects links that point at nodes which do not exist', () => {
    const spec = valid();
    spec.links.push({ from: 'api', to: 'ghost' });
    expect(errorPaths(spec)).toContain('links[2].to');
  });

  it('rejects a self-referencing link', () => {
    const spec = valid();
    spec.links.push({ from: 'api', to: 'api' });
    expect(errorPaths(spec)).toContain('links[2]');
  });

  it('rejects probabilities outside 0..1', () => {
    const spec = valid();
    spec.links[0] = { from: 'client', to: 'api', lossRate: 1.5 };
    expect(errorPaths(spec)).toContain('links[0].lossRate');
  });

  it('rejects a workload attached to a node that does not exist', () => {
    const spec = valid();
    spec.workloads[0] = {
      id: 'w',
      clientId: 'nobody',
      operation: 'HTTP_GET',
      arrival: { kind: 'constant', ratePerSec: 1 },
    };
    expect(errorPaths(spec)).toContain('workloads[0].clientId');
  });

  it('rejects an unknown or malformed arrival spec', () => {
    const spec = valid();
    spec.workloads[0]!.arrival = { kind: 'chaotic' } as never;
    expect(errorPaths(spec)).toContain('workloads[0].arrival.kind');

    const zeroRate = valid();
    zeroRate.workloads[0]!.arrival = { kind: 'constant', ratePerSec: 0 };
    expect(errorPaths(zeroRate)).toContain('workloads[0].arrival.ratePerSec');
  });

  it('rejects a latency range whose minimum exceeds its maximum', () => {
    const spec = valid();
    spec.links[0] = { from: 'client', to: 'api', latency: { kind: 'uniform', min: 50, max: 10 } };
    expect(errorPaths(spec)).toContain('links[0].latency');
  });

  it('rejects a partition with fewer than two sides, or unknown members', () => {
    const spec = valid();
    spec.partitions = [{ id: 'p', groups: [['client']] }];
    expect(errorPaths(spec)).toContain('partitions[0].groups');

    const unknown = valid();
    unknown.partitions = [{ id: 'p', groups: [['client'], ['ghost']] }];
    expect(errorPaths(unknown)).toContain('partitions[0].groups[1][0]');
  });

  it('collects every problem rather than stopping at the first', () => {
    expect(errorPaths({ version: SPEC_VERSION, nodes: [], links: [], workloads: [] }).length).toBeGreaterThan(2);
  });
});

describe('resolveSimulationSpec', () => {
  it('fills in defaults for the node type', () => {
    const resolved = resolveSimulationSpec(valid());
    const db = resolved.nodes.find((n) => n.id === 'db');
    expect(db?.config.readLatency).toBe(10);
    expect(db?.config.writeLatency).toBe(30);
    expect(db?.label).toBe('db');
    expect(db?.status).toBe('healthy');
  });

  it('keeps explicit configuration over the defaults', () => {
    const spec = valid();
    spec.nodes[2] = { id: 'db', type: 'database', label: 'Primary', config: { readLatency: 500 } };
    const db = resolveSimulationSpec(spec).nodes.find((n) => n.id === 'db');
    expect(db?.config.readLatency).toBe(500);
    expect(db?.config.writeLatency).toBe(30); // still the type default
    expect(db?.label).toBe('Primary');
  });

  it('derives link ids from the endpoints when none is given', () => {
    expect(resolveSimulationSpec(valid()).links.map((l) => l.id)).toEqual(['client->api', 'api->db']);
  });

  it('applies workload defaults', () => {
    const workload = resolveSimulationSpec(valid()).workloads[0]!;
    expect(workload.startAt).toBe(0);
    expect(workload.sizeBytes).toBe(512);
    expect(workload.deadlineMs).toBe(DEFAULT_REQUEST_DEADLINE_MS);
    expect(workload.maxRequests).toBe(Number.POSITIVE_INFINITY);
  });

  it('normalises the seed to a string so numeric seeds behave identically', () => {
    expect(resolveSimulationSpec({ ...valid(), seed: 7 }).seed).toBe('7');
  });
});

describe('export and import', () => {
  it('round-trips a scenario through JSON unchanged', () => {
    const spec = valid();
    const parsed = parseSimulationSpec(serializeSimulationSpec(spec));
    expect('spec' in parsed && parsed.spec).toEqual(spec);
  });

  it('reports invalid JSON rather than throwing', () => {
    const result = parseSimulationSpec('{not json');
    expect('errors' in result).toBe(true);
    expect('errors' in result && result.errors[0]?.message).toMatch(/invalid JSON/);
  });

  it('refuses a structurally valid JSON document that is not a valid scenario', () => {
    const result = parseSimulationSpec(JSON.stringify({ version: 1, id: 'x' }));
    expect('errors' in result).toBe(true);
  });
});
