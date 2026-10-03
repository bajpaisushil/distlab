import type { ResolvedSpec, SimEvent } from '@distlab/shared';
import { describe } from '@distlab/telemetry';
import { configured, measured, type Explanation, type Fact } from './types.js';
import { at, humanize, list, ms, percent, plural } from './text.js';

/** A node's state as the engine reports it; structurally the engine's NodeSnapshot. */
export interface NodeStateView {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly inFlight: number;
  readonly queueDepth: number;
  readonly processed: number;
  readonly failed: number;
  readonly rejected: number;
}

export interface EventEvidence {
  readonly event: SimEvent;
  /** Causal ancestors, root first, ending with the event itself. */
  readonly chain: readonly SimEvent[];
  readonly effects: readonly SimEvent[];
  readonly nodesBefore: readonly NodeStateView[];
  readonly spec: ResolvedSpec;
}

/** Why one event happened and what it set in motion, from the causal chain alone. */
export function explainEvent({ event, chain, effects, nodesBefore, spec }: EventEvidence): Explanation {
  const facts: Fact[] = [];
  const label = (id: string) => spec.nodes.find((n) => n.id === id)?.label ?? id;

  const ancestors = chain.slice(0, -1);
  for (const cause of ancestors) facts.push(measured(`${at(cause.at)}: ${describe(cause)}.`, cause.id));
  facts.push(measured(`${at(event.at)}: ${describe(event)}.`, event.id));

  const before = event.nodeId ? nodesBefore.find((n) => n.id === event.nodeId) : undefined;
  const node = event.nodeId ? spec.nodes.find((n) => n.id === event.nodeId) : undefined;
  if (before && node && node.type !== 'client') {
    facts.push(
      measured(
        `Immediately before, ${label(before.id)} was ${before.status} with ${before.inFlight} of ${node.config.concurrency} slots busy and ${before.queueDepth} of ${node.config.queueCapacity} queued.`,
        event.id,
      ),
    );
  }

  const specific = typeSpecific(event, spec, label);
  facts.push(...specific.facts);

  if (effects.length > 0) {
    const counts = new Map<string, number>();
    for (const effect of effects) counts.set(effect.type, (counts.get(effect.type) ?? 0) + 1);
    facts.push(
      measured(
        `It directly caused ${plural(effects.length, 'event')}: ${list([...counts].map(([type, n]) => `${n} × ${humanize(type).toLowerCase()}`))}.`,
        ...effects.slice(0, 20).map((e) => e.id),
      ),
    );
  }

  const root = ancestors[0];
  const summary = root
    ? `${capitalise(describe(event))}. It traces back through ${plural(ancestors.length, 'step')} to ${describe(root)} at ${at(root.at)}.${specific.summary ? ` ${specific.summary}` : ''}`
    : `${capitalise(describe(event))}. Nothing caused it: it starts a chain.${specific.summary ? ` ${specific.summary}` : ''}`;

  return {
    title: `${humanize(event.type)} at ${at(event.at)}`,
    summary,
    facts,
    interpretation: specific.interpretation,
    suggestions: [],
  };
}

function typeSpecific(
  event: SimEvent,
  spec: ResolvedSpec,
  label: (id: string) => string,
): { summary: string; facts: Fact[]; interpretation: string[] } {
  switch (event.type) {
    case 'MESSAGE_DROPPED': {
      const p = (event as SimEvent<'MESSAGE_DROPPED'>).payload;
      const link = p.linkId ? spec.links.find((l) => l.id === p.linkId) : undefined;
      const facts: Fact[] = [];
      if (p.reason === 'packet_loss' && link) facts.push(configured(`Link ${link.id} is configured to lose ${percent(link.lossRate)} of messages.`));
      return {
        summary: dropMeaning(p.reason, label(p.source), label(p.destination)),
        facts,
        interpretation: ['The sender is not told: it only finds out by waiting.'],
      };
    }
    case 'REQUEST_REJECTED': {
      const p = (event as SimEvent<'REQUEST_REJECTED'>).payload;
      const node = spec.nodes.find((n) => n.id === p.nodeId);
      return {
        summary: `${label(p.nodeId)} turned the request away (${p.reason.replace(/_/g, ' ')}).`,
        facts: node ? [configured(`${label(node.id)} allows ${node.config.concurrency} concurrent requests and ${node.config.queueCapacity} waiting.`)] : [],
        interpretation: ['Shedding load early keeps latency bounded for the requests that are admitted.'],
      };
    }
    case 'TIMEOUT': {
      const p = (event as SimEvent<'TIMEOUT'>).payload;
      return {
        summary: `${label(p.nodeId)} stopped waiting for ${p.requestId} at its deadline (${at(p.deadlineAt)}).`,
        facts: [],
        interpretation: [],
      };
    }
    case 'REQUEST_FAILED': {
      const p = (event as SimEvent<'REQUEST_FAILED'>).payload;
      return {
        summary: `Open the request's trace (${p.traceId}) for the full story of where it went wrong.`,
        facts: [measured(`${p.requestId} failed after ${ms(p.latency)}: ${p.reason.replace(/_/g, ' ')}.`, event.id)],
        interpretation: [],
      };
    }
    default:
      return { summary: '', facts: [], interpretation: [] };
  }
}

function dropMeaning(reason: string, source: string, destination: string): string {
  switch (reason) {
    case 'packet_loss':
      return `The link between ${source} and ${destination} lost it at random, as configured.`;
    case 'partitioned':
      return `A partition separated ${source} from ${destination}, so it vanished.`;
    case 'link_down':
      return `The link from ${source} to ${destination} was down.`;
    case 'destination_failed':
      return `${destination} was down when it arrived.`;
    case 'source_failed':
      return `${source} was down when it tried to send.`;
    case 'no_link':
      return `There is no link from ${source} to ${destination}.`;
    default:
      return '';
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
