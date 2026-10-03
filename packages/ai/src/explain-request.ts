import {
  type Message,
  type ResolvedSpec,
  type ResponseBody,
  type SimEvent,
} from '@distlab/shared';
import { configured, derived, measured, type Explanation, type Fact } from './types.js';
import { at, list, ms, percent } from './text.js';

export interface RequestEvidence {
  /** Every event carrying the request's trace id, in processing order. */
  readonly events: readonly SimEvent[];
  /**
   * Events from the request's lifetime that belong to no trace but may have
   * decided its fate: crashes, recoveries, partitions, link changes, pauses.
   */
  readonly context: readonly SimEvent[];
  readonly spec: ResolvedSpec;
}

const CONTEXT_TYPES = new Set([
  'NODE_FAILED',
  'NODE_RECOVERED',
  'PARTITION_STARTED',
  'PARTITION_HEALED',
  'LINK_STATE_CHANGED',
  'LINK_CONFIG_CHANGED',
  'NODE_PAUSED',
  'NODE_RESUMED',
  'NODE_CONDITION_CHANGED',
  'FAULT_INJECTED',
]);

/** Event types worth fetching as context for a request explanation. */
export const REQUEST_CONTEXT_TYPES: readonly string[] = [...CONTEXT_TYPES];

/**
 * Why a request ended the way it did, from its own events and the faults
 * around it. Every number is read from an event; nothing is estimated.
 */
export function explainRequest({ events, context, spec }: RequestEvidence): Explanation {
  const created = events.find((e) => e.type === 'REQUEST_CREATED') as SimEvent<'REQUEST_CREATED'> | undefined;
  if (!created) {
    return {
      title: 'Request',
      summary: 'There is no record of this request being created at the current replay position.',
      facts: [],
      interpretation: [],
      suggestions: [],
    };
  }
  const requestId = created.payload.requestId;
  const completed = events.find((e) => e.type === 'REQUEST_COMPLETED') as SimEvent<'REQUEST_COMPLETED'> | undefined;
  const failed = events.find((e) => e.type === 'REQUEST_FAILED') as SimEvent<'REQUEST_FAILED'> | undefined;
  const label = (id: string) => spec.nodes.find((n) => n.id === id)?.label ?? id;

  const breakdown = timeBreakdown(events);
  const facts: Fact[] = [
    measured(`${requestId} was created at ${label(created.payload.clientId)} at ${at(created.at)} (${created.payload.operation}).`, created.id),
  ];
  for (const hop of breakdown.hops) facts.push(hop.fact);

  if (completed) {
    const p = completed.payload;
    const total = p.latency;
    const parts = [
      ['the network', breakdown.network],
      ['processing', breakdown.processing],
      ['queues', breakdown.queued],
    ] as const;
    facts.push(
      measured(`It completed at ${at(completed.at)}, ${ms(total)} end to end, via ${p.path.map(label).join(' → ')}.`, completed.id),
      derived(
        `Time split: ${ms(breakdown.network)} on the network, ${ms(breakdown.processing)} processing, ${ms(breakdown.queued)} waiting in queues.`,
      ),
    );
    const [dominant] = [...parts].sort((a, b) => b[1] - a[1]);
    const interpretation =
      dominant && total > 0
        ? [`${capitalise(dominant[0])} accounts for ${percent(dominant[1] / total)} of this request's latency, so that is where a change would move it most.`]
        : [];
    return {
      title: `${requestId} completed in ${ms(total)}`,
      summary: `${requestId} succeeded in ${ms(total)}: ${ms(breakdown.network)} on the network, ${ms(breakdown.processing)} processing and ${ms(breakdown.queued)} queued, across ${p.hops} ${p.hops === 1 ? 'hop' : 'hops'}.`,
      facts,
      interpretation,
      suggestions: [],
    };
  }

  if (!failed) {
    const last = events[events.length - 1];
    return {
      title: `${requestId} is still in progress`,
      summary: `${requestId} has not finished at the current replay position; its last event so far is at ${last ? at(last.at) : 'creation'}.`,
      facts,
      interpretation: [],
      suggestions: ['Step forward or run on to see how it ends.'],
    };
  }

  const p = failed.payload;
  facts.push(measured(`It failed at ${at(failed.at)} after ${ms(p.latency)} with status "${p.status}" (${p.reason}).`, failed.id));
  const cause = rootCause({ events, context, spec, failed, label });
  facts.push(...cause.facts);

  return {
    title: `${requestId} failed: ${p.reason.replace(/_/g, ' ')}`,
    summary: `${requestId} failed after ${ms(p.latency)}. ${cause.summary}`,
    facts,
    interpretation: cause.interpretation,
    suggestions: cause.suggestions,
  };
}

interface Cause {
  summary: string;
  facts: Fact[];
  interpretation: string[];
  suggestions: string[];
}

function rootCause({
  events,
  context,
  spec,
  failed,
  label,
}: RequestEvidence & { failed: SimEvent<'REQUEST_FAILED'>; label(id: string): string }): Cause {
  const reason = failed.payload.reason;
  const drops = events.filter((e) => e.type === 'MESSAGE_DROPPED') as SimEvent<'MESSAGE_DROPPED'>[];
  const relevantContext = context.filter((e) => CONTEXT_TYPES.has(e.type));

  if (reason === 'timeout') {
    if (drops.length > 0) {
      const drop = drops[0]!;
      const d = drop.payload;
      const link = d.linkId ? spec.links.find((l) => l.id === d.linkId) : undefined;
      const facts: Fact[] = [
        measured(
          `A message from ${label(d.source)} to ${label(d.destination)} was dropped at ${at(drop.at)}: ${d.reason.replace(/_/g, ' ')}.`,
          drop.id,
        ),
      ];
      if (d.reason === 'packet_loss' && link) facts.push(configured(`Link ${link.id} is configured to lose ${percent(link.lossRate)} of messages.`));
      if (d.reason === 'partitioned') {
        const partition = relevantContext.find((e) => e.type === 'PARTITION_STARTED' && e.at <= drop.at);
        if (partition) facts.push(measured(`A network partition had started at ${at(partition.at)}.`, partition.id));
      }
      facts.push(
        derived(`Nothing replaced the lost message, so the client waited out its whole deadline (${ms(failed.payload.latency)}).`),
      );
      return {
        summary: `A message on its path was lost (${d.reason.replace(/_/g, ' ')} between ${label(d.source)} and ${label(d.destination)}), and the client then waited for its full deadline because nothing tells a sender that a packet vanished.`,
        facts,
        interpretation: ['A single lost message cost the whole deadline: the client had no faster way to learn that the request was gone.'],
        suggestions: [
          'Try a per-attempt timeout shorter than the deadline, with a retry, so one lost message does not cost the whole budget.',
        ],
      };
    }

    const crash = relevantContext.find(
      (e) => e.type === 'NODE_FAILED' && pathNodes(events).includes((e as SimEvent<'NODE_FAILED'>).payload.nodeId),
    ) as SimEvent<'NODE_FAILED'> | undefined;
    if (crash) {
      return {
        summary: `${label(crash.payload.nodeId)} crashed at ${at(crash.at)} while the request depended on it; its in-memory work was lost and nothing answered, so the client waited out its deadline.`,
        facts: [measured(`${label(crash.payload.nodeId)} failed at ${at(crash.at)} (${crash.payload.reason}).`, crash.id)],
        interpretation: ['A crash is silent to the caller: the request is simply never answered.'],
        suggestions: ['Compare with a run where the node recovers sooner, or add a redundant instance behind the load balancer.'],
      };
    }

    const pause = relevantContext.find((e) => e.type === 'NODE_PAUSED') as SimEvent<'NODE_PAUSED'> | undefined;
    if (pause) {
      const who = label(pause.payload.nodeId);
      const resumed = relevantContext.find(
        (e) => e.type === 'NODE_RESUMED' && (e as SimEvent<'NODE_RESUMED'>).payload.nodeId === pause.payload.nodeId && e.at >= pause.at,
      ) as SimEvent<'NODE_RESUMED'> | undefined;
      return {
        summary: `${who} froze at ${at(pause.at)} while the request depended on it; it held the request without doing anything until the deadline passed.`,
        facts: [
          measured(`${who} froze at ${at(pause.at)}.`, pause.id),
          ...(resumed
            ? [measured(`It resumed at ${at(resumed.at)} after ${ms(resumed.payload.pausedForMs)}, with ${resumed.payload.heldEvents} events waiting.`, resumed.id)]
            : []),
        ],
        interpretation: ['To its callers, a frozen node is indistinguishable from a crashed one or a very slow network — until it wakes up and carries on.'],
        suggestions: ['A shorter call timeout with a retry to another instance would route around the freeze.'],
      };
    }

    const waits = queueWaits(events);
    const worst = waits.sort((a, b) => b.wait - a.wait)[0];
    if (worst && worst.wait > 0) {
      return {
        summary: `The request spent ${ms(worst.wait)} waiting in ${label(worst.nodeId)}'s queue before it was even started, and the deadline ran out.`,
        facts: [measured(`It waited ${ms(worst.wait)} in ${label(worst.nodeId)}'s queue.`, ...worst.eventIds)],
        interpretation: [`${label(worst.nodeId)} was saturated: every worker slot was busy when the request arrived.`],
        suggestions: [`Try more concurrency at ${label(worst.nodeId)}, a shorter queue so excess load is shed early, or less traffic.`],
      };
    }

    return {
      summary: 'The deadline passed before every hop had answered; the request was still in progress downstream.',
      facts: [],
      interpretation: ['Processing and network time along the path added up to more than the deadline allows.'],
      suggestions: ['Compare the deadline with the sum of service and link latencies along the path.'],
    };
  }

  if (reason === 'queue_full') {
    const rejected = events.find((e) => e.type === 'REQUEST_REJECTED') as SimEvent<'REQUEST_REJECTED'> | undefined;
    const node = rejected ? spec.nodes.find((n) => n.id === rejected.payload.nodeId) : undefined;
    const facts: Fact[] = [];
    if (rejected) facts.push(measured(`${label(rejected.payload.nodeId)} rejected it at ${at(rejected.at)} with ${rejected.payload.queueDepth} requests already waiting.`, rejected.id));
    if (node) facts.push(configured(`${label(node.id)} works on ${node.config.concurrency} requests at once and queues at most ${node.config.queueCapacity} more.`));
    return {
      summary: rejected
        ? `${label(rejected.payload.nodeId)} was full — every worker busy and its queue at capacity — so it shed the request rather than let the backlog grow.`
        : 'A node on the path was full and shed the request.',
      facts,
      interpretation: ['Rejection is backpressure working as designed: failing fast beats queueing work that will time out anyway.'],
      suggestions: node ? [`Try more concurrency at ${label(node.id)}, or reduce the offered load.`] : [],
    };
  }

  if (reason === 'unreachable' || reason === 'no_route') {
    const at_ = failed.payload.failedAt;
    const downs = relevantContext.filter((e) => e.type === 'NODE_FAILED' || e.type === 'LINK_STATE_CHANGED');
    return {
      summary:
        reason === 'no_route'
          ? 'The client has no outgoing link, so the request had nowhere to go.'
          : `${at_ ? label(at_) : 'A node'} had no usable downstream: everything it could forward to was down or cut off.`,
      facts: downs.slice(0, 3).map((e) =>
        e.type === 'NODE_FAILED'
          ? measured(`${label((e as SimEvent<'NODE_FAILED'>).payload.nodeId)} had failed at ${at(e.at)}.`, e.id)
          : measured(`Link ${(e as SimEvent<'LINK_STATE_CHANGED'>).payload.linkId} changed state at ${at(e.at)}.`, e.id),
      ),
      interpretation: ['Failing fast here is correct: a dead downstream is visible locally, unlike a partition.'],
      suggestions: ['Add redundant downstream instances so one failure leaves a path open.'],
    };
  }

  if (reason === 'processing_error') {
    const where = failed.payload.failedAt;
    const node = where ? spec.nodes.find((n) => n.id === where) : undefined;
    return {
      summary: `${where ? label(where) : 'A node'} failed while processing the request.`,
      facts: node && node.config.failureProbability > 0
        ? [configured(`${label(node.id)} is configured to fail ${percent(node.config.failureProbability)} of requests regardless of load.`)]
        : [],
      interpretation: [],
      suggestions: ['Retries would mask a random processing failure, at the cost of extra load.'],
    };
  }

  return {
    summary: `The response came back with status "${failed.payload.status}".`,
    facts: [],
    interpretation: [],
    suggestions: [],
  };
}

interface Hop {
  fact: Fact;
}

/** Network, processing and queueing time along the request's path. */
function timeBreakdown(events: readonly SimEvent[]): { network: number; processing: number; queued: number; hops: Hop[] } {
  let network = 0;
  let processing = 0;
  const hops: Hop[] = [];
  for (const event of events) {
    if (event.type === 'MESSAGE_RECEIVED') {
      const message = (event as SimEvent<'MESSAGE_RECEIVED'>).payload.message as Message;
      if (message.duplicateOf) continue;
      const transit = event.at - message.createdAt;
      network += transit;
      const what = message.kind === 'RESPONSE' ? `response (${(message.payload as ResponseBody).status})` : 'request';
      hops.push({ fact: measured(`The ${what} took ${ms(transit)} on the wire from ${message.source} to ${message.destination}.`, event.id) });
    } else if (event.type === 'REQUEST_PROCESSING_COMPLETED') {
      const p = (event as SimEvent<'REQUEST_PROCESSING_COMPLETED'>).payload;
      processing += p.serviceTime;
      hops.push({ fact: measured(`${p.nodeId} processed it for ${ms(p.serviceTime)} (${p.outcome}).`, event.id) });
    }
  }
  const queued = queueWaits(events).reduce((sum, w) => sum + w.wait, 0);
  return { network, processing, queued, hops };
}

function queueWaits(events: readonly SimEvent[]): { nodeId: string; wait: number; eventIds: string[] }[] {
  const waits: { nodeId: string; wait: number; eventIds: string[] }[] = [];
  const queuedAt = new Map<string, SimEvent>();
  for (const event of events) {
    if (event.type === 'REQUEST_QUEUED') queuedAt.set((event as SimEvent<'REQUEST_QUEUED'>).payload.nodeId, event);
    if (event.type === 'REQUEST_PROCESSING_STARTED') {
      const nodeId = (event as SimEvent<'REQUEST_PROCESSING_STARTED'>).payload.nodeId;
      const queued = queuedAt.get(nodeId);
      if (queued) {
        waits.push({ nodeId, wait: event.at - queued.at, eventIds: [queued.id, event.id] });
        queuedAt.delete(nodeId);
      }
    }
  }
  // Still queued when the request ended.
  const last = events[events.length - 1];
  for (const [nodeId, queued] of queuedAt) {
    if (last) waits.push({ nodeId, wait: last.at - queued.at, eventIds: [queued.id] });
  }
  return waits;
}

function pathNodes(events: readonly SimEvent[]): string[] {
  const nodes = new Set<string>();
  for (const event of events) {
    if (event.type === 'REQUEST_ROUTED') {
      const p = (event as SimEvent<'REQUEST_ROUTED'>).payload;
      nodes.add(p.from);
      nodes.add(p.to);
    }
  }
  return [...nodes];
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export { list as joinList };
