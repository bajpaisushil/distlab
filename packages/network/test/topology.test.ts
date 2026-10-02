import { describe, expect, it } from 'vitest';
import { DEFAULT_LINK_CONFIG, type LinkConfig } from '@distlab/shared';
import { Topology } from '../src/topology.js';

const link = (id: string, from: string, to: string, overrides: Partial<LinkConfig> = {}): LinkConfig => ({
  ...DEFAULT_LINK_CONFIG,
  id,
  from,
  to,
  ...overrides,
});

describe('Topology', () => {
  it('resolves links in both directions when bidirectional', () => {
    const topology = new Topology([link('l1', 'a', 'b')]);
    expect(topology.linkFor('a', 'b')?.id).toBe('l1');
    expect(topology.linkFor('b', 'a')?.id).toBe('l1');
  });

  it('resolves only the forward direction of a one-way link', () => {
    const topology = new Topology([link('l1', 'a', 'b', { bidirectional: false })]);
    expect(topology.linkFor('a', 'b')?.id).toBe('l1');
    expect(topology.linkFor('b', 'a')).toBeUndefined();
  });

  it('orders outgoing links by id so routing does not depend on insertion order', () => {
    const forward = new Topology([link('z', 'a', 'z'), link('m', 'a', 'm'), link('b', 'a', 'b')]);
    const reverse = new Topology([link('b', 'a', 'b'), link('m', 'a', 'm'), link('z', 'a', 'z')]);
    expect(forward.outgoingFrom('a').map((l) => l.id)).toEqual(['b', 'm', 'z']);
    expect(reverse.outgoingFrom('a').map((l) => l.id)).toEqual(['b', 'm', 'z']);
  });

  it('excludes disabled links from downstream neighbours', () => {
    const topology = new Topology([link('l1', 'a', 'b'), link('l2', 'a', 'c', { enabled: false })]);
    expect(topology.downstreamOf('a')).toEqual(['b']);
  });

  it('updates a link in place', () => {
    const topology = new Topology([link('l1', 'a', 'b')]);
    topology.updateLink('l1', { lossRate: 0.5 });
    expect(topology.getLink('l1')?.lossRate).toBe(0.5);
    expect(topology.updateLink('missing', { lossRate: 1 })).toBeUndefined();
  });
});

describe('partitions', () => {
  it('separates nodes placed in different groups', () => {
    const topology = new Topology([link('l1', 'a', 'b')], [{ id: 'p', groups: [['a'], ['b']] }]);
    expect(topology.isPartitioned('a', 'b')).toBe(true);
    expect(topology.isPartitioned('b', 'a')).toBe(true);
  });

  it('leaves nodes in the same group connected', () => {
    const topology = new Topology([], [{ id: 'p', groups: [['a', 'b'], ['c']] }]);
    expect(topology.isPartitioned('a', 'b')).toBe(false);
    expect(topology.isPartitioned('a', 'c')).toBe(true);
  });

  it('ignores nodes that the partition does not mention', () => {
    const topology = new Topology([], [{ id: 'p', groups: [['a'], ['b']] }]);
    expect(topology.isPartitioned('a', 'unlisted')).toBe(false);
  });

  it('applies every active partition', () => {
    const topology = new Topology([]);
    topology.addPartition({ id: 'p1', groups: [['a'], ['b']] });
    topology.addPartition({ id: 'p2', groups: [['c'], ['d']] });
    expect(topology.isPartitioned('a', 'b')).toBe(true);
    expect(topology.isPartitioned('c', 'd')).toBe(true);
    expect(topology.removePartition('p1')).toBe(true);
    expect(topology.isPartitioned('a', 'b')).toBe(false);
    expect(topology.isPartitioned('c', 'd')).toBe(true);
  });

  it('replaces a partition that is re-added with the same id', () => {
    const topology = new Topology([]);
    topology.addPartition({ id: 'p', groups: [['a'], ['b']] });
    topology.addPartition({ id: 'p', groups: [['a'], ['c']] });
    expect(topology.isPartitioned('a', 'b')).toBe(false);
    expect(topology.isPartitioned('a', 'c')).toBe(true);
  });
});
