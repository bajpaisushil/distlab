import { describe, expect, it } from 'vitest';
import { DEFAULT_LINK_CONFIG, type LinkConfig } from '@distlab/shared';
import { SimulatedNetwork } from '../src/network.js';
import { TestContext, request } from './harness.js';

function link(overrides: Partial<LinkConfig> = {}): LinkConfig {
  return { ...DEFAULT_LINK_CONFIG, id: 'a->b', from: 'a', to: 'b', ...overrides };
}

function setup(links: LinkConfig[], options: { isNodeUp?: (id: string) => boolean } = {}) {
  const context = new TestContext();
  const network = new SimulatedNetwork({
    context,
    links,
    ...(options.isNodeUp ? { isNodeUp: options.isNodeUp } : {}),
  });
  network.attach((type, handler) => context.on(type, handler));
  return { context, network };
}

describe('delivery', () => {
  it('delivers a message after the link latency', () => {
    const { context, network } = setup([link({ latency: 25 })]);
    network.send(request());
    context.drain();

    const delivered = context.eventsOfType('MESSAGE_RECEIVED');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.at).toBe(25);
    expect(delivered[0]?.payload.message.status).toBe('delivered');
  });

  it('applies jitter within the configured bounds', () => {
    const { context, network } = setup([link({ latency: { kind: 'uniform', min: 10, max: 30 } })]);
    for (let i = 0; i < 200; i++) network.send(request());
    context.drain();

    const arrivals = context.eventsOfType('MESSAGE_RECEIVED').map((e) => e.at);
    expect(Math.min(...arrivals)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...arrivals)).toBeLessThanOrEqual(30);
    expect(new Set(arrivals).size).toBeGreaterThan(50); // genuinely varying
  });

  it('carries traffic in the reverse direction of a bidirectional link', () => {
    const { context, network } = setup([link({ bidirectional: true })]);
    network.send(request({ source: 'b', destination: 'a' }));
    context.drain();
    expect(context.eventsOfType('MESSAGE_RECEIVED')).toHaveLength(1);
  });

  it('refuses the reverse direction of a one-way link', () => {
    const { context, network } = setup([link({ bidirectional: false })]);
    network.send(request({ source: 'b', destination: 'a' }));
    context.drain();
    expect(context.eventsOfType('MESSAGE_DROPPED')[0]?.payload.reason).toBe('no_link');
  });

  it('drops a message when no link exists at all', () => {
    const { context, network } = setup([link()]);
    expect(network.send(request({ destination: 'zzz' }))).toBeUndefined();
    context.drain();
    expect(context.eventsOfType('MESSAGE_DROPPED')[0]?.payload.reason).toBe('no_link');
  });
});

describe('impairments', () => {
  it('drops everything at 100% loss', () => {
    const { context, network } = setup([link({ lossRate: 1 })]);
    for (let i = 0; i < 20; i++) network.send(request());
    context.drain();
    expect(context.eventsOfType('MESSAGE_RECEIVED')).toHaveLength(0);
    expect(context.eventsOfType('MESSAGE_DROPPED')).toHaveLength(20);
    expect(context.eventsOfType('MESSAGE_DROPPED')[0]?.payload.reason).toBe('packet_loss');
  });

  it('drops roughly the configured fraction', () => {
    const { context, network } = setup([link({ lossRate: 0.2 })]);
    for (let i = 0; i < 4000; i++) network.send(request());
    context.drain();
    const dropped = context.eventsOfType('MESSAGE_DROPPED').length;
    expect(dropped / 4000).toBeGreaterThan(0.17);
    expect(dropped / 4000).toBeLessThan(0.23);
  });

  it('delivers duplicates as separate messages that point back at the original', () => {
    const { context, network } = setup([link({ duplicateRate: 1 })]);
    network.send(request());
    context.drain();

    const received = context.received();
    expect(received).toHaveLength(2);
    const copy = received.find((m) => m.duplicateOf !== undefined);
    expect(copy).toBeDefined();
    expect(copy?.duplicateOf).toBe(received.find((m) => m.duplicateOf === undefined)?.id);
    // Same request and span: a duplicate is the same call arriving twice.
    expect(copy?.requestId).toBe(received[0]?.requestId);
    expect(context.eventsOfType('MESSAGE_DUPLICATED')).toHaveLength(1);
  });

  it('reorders messages by delaying some of them past later ones', () => {
    const { context, network } = setup([
      link({ latency: 10, reorderRate: 0.5, reorderDelay: 500 }),
    ]);
    const sent = Array.from({ length: 40 }, () => network.send(request())?.id);
    context.drain();

    const arrivalOrder = context.received().map((m) => m.id);
    expect(arrivalOrder).not.toEqual(sent);
    expect([...arrivalOrder].sort()).toEqual([...sent].sort());
  });

  it('leaves order intact when nothing is impaired', () => {
    const { context, network } = setup([link({ latency: 10 })]);
    const sent = Array.from({ length: 20 }, () => network.send(request())?.id);
    context.drain();
    expect(context.received().map((m) => m.id)).toEqual(sent);
  });

  it('serialises messages onto a bandwidth-limited link so they queue', () => {
    // 1000 bytes/sec with 500-byte messages: 500ms of wire time each.
    const { context, network } = setup([link({ latency: 0, bandwidthBytesPerSec: 1000 })]);
    for (let i = 0; i < 3; i++) network.send(request({ sizeBytes: 500 }));
    context.drain();
    expect(context.eventsOfType('MESSAGE_RECEIVED').map((e) => e.at)).toEqual([500, 1000, 1500]);
  });

  it('delivers in parallel when bandwidth is unlimited', () => {
    const { context, network } = setup([link({ latency: 10, bandwidthBytesPerSec: 0 })]);
    for (let i = 0; i < 3; i++) network.send(request({ sizeBytes: 50_000 }));
    context.drain();
    expect(context.eventsOfType('MESSAGE_RECEIVED').map((e) => e.at)).toEqual([10, 10, 10]);
  });
});

describe('outages', () => {
  it('drops traffic across a disabled link', () => {
    const { context, network } = setup([link()]);
    network.setLinkEnabled('a->b', false);
    network.send(request());
    context.drain();
    expect(context.eventsOfType('MESSAGE_DROPPED')[0]?.payload.reason).toBe('link_down');
  });

  it('drops traffic across a partition and restores it when the partition heals', () => {
    const { context, network } = setup([link()]);
    network.addPartition({ id: 'split', groups: [['a'], ['b']] });
    network.send(request());
    context.drain();
    expect(context.eventsOfType('MESSAGE_DROPPED')[0]?.payload.reason).toBe('partitioned');

    network.removePartition('split');
    network.send(request());
    context.drain();
    expect(context.eventsOfType('MESSAGE_RECEIVED')).toHaveLength(1);
  });

  it('does not deliver to a node that is down', () => {
    const { context, network } = setup([link()], { isNodeUp: (id) => id !== 'b' });
    network.send(request());
    context.drain();
    expect(context.eventsOfType('MESSAGE_DROPPED')[0]?.payload.reason).toBe('destination_failed');
  });

  it('records what happened in its counters', () => {
    const { context, network } = setup([link({ lossRate: 1 })]);
    for (let i = 0; i < 5; i++) network.send(request());
    context.drain();
    expect(network.stats.sent).toBe(5);
    expect(network.stats.dropped).toBe(5);
    expect(network.stats.delivered).toBe(0);
  });
});
