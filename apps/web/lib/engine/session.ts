import {
  meanLatency,
  validateSimulationSpec,
  type ResponseBody,
  type SimEvent,
  type SimulationSpec,
  type SpecIssue,
} from '@distlab/shared';
import { createSimulation, ReplayController } from '@distlab/simulation-engine';
import { describe, type LogLevel } from '@distlab/telemetry';
import type {
  EventDetail,
  EventFilter,
  Frame,
  InFlightMessage,
  LinkState,
  LogFilter,
  MarkerKind,
  Page,
  Query,
  QueryResults,
  RunSummary,
  TimelineMarker,
} from './protocol';

const RECENT_EVENTS = 250;
const MAX_IN_FLIGHT = 600;
const MAX_MARKERS = 2000;

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Event types worth flagging on the replay timeline. Keyed by name rather than
 * the EventType union so subsystems can add events without touching this file;
 * unknown names simply never match.
 */
const MARKER_KINDS: Readonly<Record<string, MarkerKind>> = {
  FAULT_INJECTED: 'fault',
  NODE_FAILED: 'failure',
  NODE_RECOVERED: 'recovery',
  PARTITION_STARTED: 'partition',
  PARTITION_HEALED: 'recovery',
  LEADER_ELECTED: 'leader',
  SAFETY_VIOLATION: 'violation',
  CIRCUIT_OPENED: 'circuit',
  CIRCUIT_CLOSED: 'recovery',
  NODE_PAUSED: 'failure',
  NODE_RESUMED: 'recovery',
};

export type LoadResult = { readonly ok: true } | { readonly ok: false; readonly issues: readonly SpecIssue[] };

/**
 * One interactive run: the replay controller plus everything the lab needs
 * to drive and inspect it.
 *
 * Deliberately free of worker plumbing so it can be tested in Node. The worker
 * only translates messages into these calls and owns the playback clock.
 */
export class LabSession {
  private controller: ReplayController | undefined;
  private spec: SimulationSpec | undefined;
  private markers: TimelineMarker[] = [];
  private markerScanned = 0;
  private indexById = new Map<string, number>();
  private indexed = 0;
  private seq = 0;

  get loaded(): boolean {
    return this.controller !== undefined;
  }

  get now(): number {
    return this.controller?.current.now ?? 0;
  }

  get completed(): boolean {
    return this.controller?.completed ?? false;
  }

  /**
   * Builds a fresh run from `spec`. With `keepTime`, the new run is replayed up
   * to the virtual time the previous one had reached — editing a scenario while
   * paused at 3.2s lands you at 3.2s in the edited world.
   */
  load(spec: SimulationSpec, keepTime: boolean): LoadResult {
    const validation = validateSimulationSpec(spec);
    if (!validation.valid) return { ok: false, issues: validation.errors };
    const previousTime = keepTime ? this.now : 0;
    this.spec = spec;
    this.controller = new ReplayController(spec, { checkpointInterval: 2000, maxCheckpoints: 48 });
    this.markers = [];
    this.markerScanned = 0;
    this.indexById = new Map();
    this.indexed = 0;
    if (previousTime > 0) this.controller.advanceTime(previousTime);
    this.afterMove();
    return { ok: true };
  }

  /** Advances by virtual time, processing at most `maxEvents` so a frame budget is honoured. */
  advance(virtualMs: number, maxEvents: number): number {
    const controller = this.require();
    const target = controller.current.now + virtualMs;
    let processed = 0;
    // Bounded slices keep a dense stretch of events from stalling the worker.
    while (!controller.completed && controller.current.now < target && processed < maxEvents) {
      const before = controller.position;
      controller.advanceTime(Math.min(target - controller.current.now, 1000));
      processed += controller.position - before;
      if (controller.position === before && controller.current.now >= target) break;
    }
    this.afterMove();
    return processed;
  }

  step(count: number): void {
    this.require().forward(Math.max(1, count));
    this.afterMove();
  }

  back(count: number): void {
    this.require().back(Math.max(1, count));
    this.afterMove();
  }

  seek(position: number): void {
    this.require().seek(position);
    this.afterMove();
  }

  /** Moves to a virtual time: to the last event at or before it, then lets the clock reach it. */
  seekTime(time: number): void {
    const controller = this.require();
    const timeline = controller.timeline();
    let low = 0;
    let high = timeline.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((timeline[mid] as SimEvent).at <= time) low = mid + 1;
      else high = mid;
    }
    controller.seek(Math.min(low, controller.reachable));
    if (controller.current.now < time) controller.advanceTime(time - controller.current.now);
    this.afterMove();
  }

  toEnd(): void {
    this.require().toEnd();
    this.afterMove();
  }

  reset(): void {
    this.require().reset();
    this.afterMove();
  }

  frame(playing: boolean, speed: number): Frame {
    const controller = this.require();
    const world = controller.current;
    const now = world.now;

    const links: LinkState[] = world.network.topology.allLinks().map((link) => ({
      id: link.id,
      from: link.from,
      to: link.to,
      enabled: link.enabled,
      bidirectional: link.bidirectional,
      lossRate: link.lossRate,
      duplicateRate: link.duplicateRate,
      meanLatency: meanLatency(link.latency),
    }));

    const inFlight: InFlightMessage[] = [];
    let inFlightTotal = 0;
    world.simulation.queue.forEachPending((event) => {
      if (event.type !== 'MESSAGE_RECEIVED') return;
      inFlightTotal += 1;
      if (inFlight.length >= MAX_IN_FLIGHT) return;
      const message = (event as SimEvent<'MESSAGE_RECEIVED'>).payload.message;
      const status = message.kind === 'RESPONSE' ? (message.payload as ResponseBody).status : undefined;
      inFlight.push({
        id: message.id,
        kind: message.kind,
        source: message.source,
        destination: message.destination,
        sentAt: message.createdAt,
        deliverAt: message.deliverAt,
        ...(status !== undefined ? { status } : {}),
        duplicate: message.duplicateOf !== undefined,
      });
    });

    const position = controller.position;
    const timeline = controller.timeline();
    return {
      seq: ++this.seq,
      specId: this.spec?.id ?? '',
      position,
      reachable: controller.reachable,
      reachableTime: Math.max(now, timeline[timeline.length - 1]?.at ?? 0),
      now,
      durationMs: world.spec.durationMs,
      status: world.simulation.status,
      playing,
      speed,
      snapshot: world.snapshot(),
      nodes: world.registry.snapshot(now),
      links,
      partitions: world.network.topology.activePartitions(),
      inFlight,
      inFlightTotal,
      recent: timeline.slice(Math.max(0, position - RECENT_EVENTS), position),
      markers: this.markers,
    };
  }

  query<K extends Query['kind']>(query: Extract<Query, { kind: K }>): QueryResults[K];
  query(query: Query): QueryResults[keyof QueryResults] {
    switch (query.kind) {
      case 'events':
        return this.queryEvents(query.filter, query.offset, query.limit);
      case 'logs':
        return this.queryLogs(query.filter, query.offset, query.limit);
      case 'traces': {
        const traces = this.require().current.telemetry.traces;
        if (query.sort === 'slowest') return traces.slowest(query.limit);
        if (query.sort === 'failed') return traces.failed().slice(-query.limit).reverse();
        return traces.all().slice(-query.limit).reverse();
      }
      case 'trace':
        return this.require().current.telemetry.traces.get(query.traceId as never) ?? null;
      case 'eventDetail':
        return this.eventDetail(query.eventId);
      case 'run':
        return runToCompletion(query.spec);
    }
  }

  private queryEvents(filter: EventFilter, offset: number, limit: number): Page<SimEvent> {
    const controller = this.require();
    const timeline = controller.timeline();
    const end = filter.upToCurrent === false ? timeline.length : controller.position;
    const types = filter.types && filter.types.length > 0 ? new Set<string>(filter.types) : undefined;
    const text = filter.text?.trim().toLowerCase();
    const matches: SimEvent[] = [];
    for (let i = 0; i < end; i++) {
      const event = timeline[i] as SimEvent;
      if (types && !types.has(event.type)) continue;
      if (filter.nodeId && event.nodeId !== filter.nodeId) continue;
      if (filter.traceId && event.traceId !== filter.traceId) continue;
      if (filter.fromTime !== undefined && event.at < filter.fromTime) continue;
      if (filter.toTime !== undefined && event.at > filter.toTime) continue;
      if (text && !event.type.toLowerCase().includes(text) && !describe(event).toLowerCase().includes(text)) continue;
      matches.push(event);
    }
    const start = Math.max(0, Math.min(offset, matches.length));
    return { total: matches.length, offset: start, items: matches.slice(start, start + limit) };
  }

  private queryLogs(filter: LogFilter, offset: number, limit: number) {
    const records = this.require().current.telemetry.logs.all();
    const min = LEVELS[filter.minLevel ?? 'debug'];
    const text = filter.text?.trim().toLowerCase();
    const matches = records.filter(
      (r) =>
        LEVELS[r.level] >= min &&
        (!filter.nodeId || r.nodeId === filter.nodeId) &&
        (!text || r.message.toLowerCase().includes(text) || r.eventType.toLowerCase().includes(text)),
    );
    const start = Math.max(0, Math.min(offset, matches.length));
    return { total: matches.length, offset: start, items: matches.slice(start, start + limit) };
  }

  private eventDetail(eventId: string): EventDetail | null {
    const controller = this.require();
    const timeline = controller.timeline();
    this.indexTimeline(timeline);
    const index = this.indexById.get(eventId);
    if (index === undefined) return null;
    const event = timeline[index] as SimEvent;

    const chain: SimEvent[] = [];
    const seen = new Set<string>();
    let current: SimEvent | undefined = event;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      const parent: number | undefined = current.causedBy ? this.indexById.get(current.causedBy) : undefined;
      current = parent === undefined ? undefined : timeline[parent];
    }

    const effects: SimEvent[] = [];
    for (let i = index + 1; i < timeline.length && effects.length < 200; i++) {
      if ((timeline[i] as SimEvent).causedBy === eventId) effects.push(timeline[i] as SimEvent);
    }

    const before = controller.peek(index);
    return {
      event,
      index,
      description: describe(event),
      chain: chain.reverse(),
      effects,
      nodesBefore: before.registry.snapshot(before.now),
    };
  }

  private indexTimeline(timeline: readonly SimEvent[]): void {
    for (let i = this.indexed; i < timeline.length; i++) this.indexById.set((timeline[i] as SimEvent).id, i);
    this.indexed = timeline.length;
  }

  private afterMove(): void {
    const timeline = this.require().timeline();
    for (let i = this.markerScanned; i < timeline.length && this.markers.length < MAX_MARKERS; i++) {
      const event = timeline[i] as SimEvent;
      const kind = MARKER_KINDS[event.type];
      if (kind) {
        this.markers.push({ position: i, at: event.at, kind, label: describe(event), eventId: event.id });
      }
    }
    this.markerScanned = timeline.length;
  }

  private require(): ReplayController {
    if (!this.controller) throw new Error('no scenario loaded');
    return this.controller;
  }
}

/** Runs a spec start to finish on its own — for comparisons and what-if experiments. */
export function runToCompletion(spec: SimulationSpec): RunSummary {
  const started = performance.now();
  const world = createSimulation(spec, { logCapacity: 1, telemetry: { captureTraces: false, logCapacity: 1 } });
  const result = world.run();
  return {
    specId: spec.id,
    events: world.simulation.eventsProcessed,
    endedAt: result.endedAt,
    wallMs: performance.now() - started,
    snapshot: world.snapshot(),
  };
}
