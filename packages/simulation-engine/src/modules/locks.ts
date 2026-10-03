import {
  FREE_LOCK,
  checkFencingToken,
  expireLease,
  grantNext,
  releaseLock,
  removeWaiter,
  renewLease,
  requestLock,
  type Grant,
  type LockEntry,
} from '@distlab/algorithms';
import {
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_HOLD_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_THINK_MS,
  renewIntervalOf,
  sampleLatency,
  type CriticalSectionOutcome,
  type EventId,
  type FencedWritePayload,
  type FencedWriteResultPayload,
  type LockAcquirePayload,
  type LockClientPolicy,
  type LockGrantPayload,
  type LockRefusePayload,
  type LockReleasePayload,
  type LockRenewPayload,
  type LockRenewResultPayload,
  type Message,
  type NodeId,
  type RequestMessage,
  type SimEvent,
  type SimNode,
} from '@distlab/shared';
import type { ModuleServices, SimModule } from './types.js';

const MODULE = 'locks';
/** How much longer than its own wait budget a client allows for the service's answer to arrive. */
const ANSWER_MARGIN_MS = 500;
const WRITE_TIMEOUT_MS = 1000;

interface ServiceState {
  locks: Record<string, LockEntry>;
  /** Lease timer per lock, keyed by resource. */
  leaseTimers: Record<string, EventId>;
  /** Queue timeout per waiter, keyed by `resource|client|attempt`. */
  waitTimers: Record<string, EventId>;
  /** No grants before this instant — the service is waiting out leases it forgot in a restart. */
  graceUntil: number;
  graceTimer: EventId | undefined;
  /** Longest lease ever granted. Kept with the tokens, so a restart knows how long to wait. */
  maxLeaseMs: number;
}

type ClientPhase = 'idle' | 'waiting' | 'holding' | 'writing';

interface ClientState {
  phase: ClientPhase;
  attempt: number;
  token: number;
  /** When it asked; leases are counted from here, conservatively, since the grant took time to arrive. */
  requestedAt: number;
  acquiredAt: number;
  /** The client's own belief about when its lease ends. */
  leaseUntil: number;
  renewSentAt: number;
  /** The one pending step timer: start, give-up, work or write timeout. */
  timer: EventId | undefined;
  renewTimer: EventId | undefined;
}

interface StorageResource {
  highestToken: number;
  highestWriter: NodeId | null;
}

interface LocksState {
  services: [NodeId, ServiceState][];
  clients: [NodeId, ClientState][];
  storage: [string, StorageResource][];
}

/**
 * Distributed locks with leases and fencing tokens.
 *
 * Three roles. A lock service keeps the lock table: who holds each lock,
 * until when, and who is queued. A lock client (any server with a
 * `lockClient` policy) runs a loop — ask, wait, do the work, write to
 * storage with its fencing token, release, think, ask again — renewing its
 * lease while it works. Storage accepts those writes and, if `fencing` is on,
 * refuses any token older than the highest it has accepted.
 *
 * Everything travels over the simulated network and every wait is a timer,
 * so a frozen client stops renewing exactly as a real one would: its lease
 * runs out at the service, the next waiter gets the lock, and when the
 * frozen client wakes it carries on writing, still believing it holds it.
 */
export function createLocksModule(services: ModuleServices): SimModule {
  let serviceStates = new Map<NodeId, ServiceState>();
  let clientStates = new Map<NodeId, ClientState>();
  /** Storage's memory of the highest token accepted, keyed by `storage|resource`. Durable. */
  let storage = new Map<string, StorageResource>();

  const now = () => services.context.now();

  const serviceOf = (id: NodeId): ServiceState => {
    let state = serviceStates.get(id);
    if (!state) {
      state = { locks: {}, leaseTimers: {}, waitTimers: {}, graceUntil: 0, graceTimer: undefined, maxLeaseMs: 0 };
      serviceStates.set(id, state);
    }
    return state;
  };

  const clientOf = (id: NodeId): ClientState => {
    let state = clientStates.get(id);
    if (!state) {
      state = {
        phase: 'idle',
        attempt: 0,
        token: 0,
        requestedAt: 0,
        acquiredAt: 0,
        leaseUntil: 0,
        renewSentAt: 0,
        timer: undefined,
        renewTimer: undefined,
      };
      clientStates.set(id, state);
    }
    return state;
  };

  const send = (from: NodeId, to: NodeId, kind: Message['kind'], payload: Message['payload'], causedBy?: EventId) => {
    services.send({
      kind,
      source: from,
      destination: to,
      type: kind,
      payload,
      sizeBytes: 96,
      hop: 0,
      ...(causedBy !== undefined ? { causedBy } : {}),
    });
  };

  // --- lock service --------------------------------------------------------

  const servicePolicy = (node: SimNode) => node.config.lockService ?? {};
  const granting = (state: ServiceState) => now() >= state.graceUntil;
  const waitKey = (resource: string, clientId: NodeId, attempt: number) => `${resource}|${clientId}|${attempt}`;

  const deliverGrant = (service: SimNode, resource: string, grant: Grant, fromQueue: boolean, causedBy: EventId) => {
    const state = serviceOf(service.id);
    const key = waitKey(resource, grant.waiter.clientId, grant.waiter.attempt);
    const waitTimer = state.waitTimers[key];
    if (waitTimer !== undefined) {
      services.cancelTimer(waitTimer);
      delete state.waitTimers[key];
    }
    state.maxLeaseMs = Math.max(state.maxLeaseMs, grant.waiter.leaseMs);
    state.leaseTimers[resource] = services.setTimer(service.id, MODULE, 'lease', grant.waiter.leaseMs, { resource, token: grant.token }, causedBy);
    services.emit(
      'LOCK_ACQUIRED',
      {
        serviceId: service.id,
        resource,
        holder: grant.waiter.clientId,
        token: grant.token,
        leaseMs: grant.waiter.leaseMs,
        waitedMs: now() - grant.waiter.enqueuedAt,
        fromQueue,
      },
      { nodeId: service.id, causedBy },
    );
    const payload: LockGrantPayload = { resource, token: grant.token, leaseMs: grant.waiter.leaseMs, attempt: grant.waiter.attempt };
    send(service.id, grant.waiter.clientId, 'LOCK_GRANT', payload, causedBy);
  };

  const handOn = (service: SimNode, resource: string, causedBy: EventId) => {
    const state = serviceOf(service.id);
    const result = grantNext(state.locks[resource] ?? FREE_LOCK, now(), granting(state));
    state.locks[resource] = result.entry;
    if (result.grant) deliverGrant(service, resource, result.grant, true, causedBy);
  };

  const freeLock = (service: SimNode, resource: string) => {
    const state = serviceOf(service.id);
    const timer = state.leaseTimers[resource];
    if (timer !== undefined) services.cancelTimer(timer);
    delete state.leaseTimers[resource];
  };

  const onAcquire = (service: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const p = message.payload as LockAcquirePayload;
    const state = serviceOf(service.id);
    const waiter = { clientId: message.source, attempt: p.attempt, leaseMs: p.leaseMs, enqueuedAt: now() };
    const policy = servicePolicy(service);
    const result = requestLock(state.locks[p.resource] ?? FREE_LOCK, waiter, now(), {
      granting: granting(state),
      ...(policy.maxWaiters !== undefined ? { maxWaiters: policy.maxWaiters } : {}),
    });
    state.locks[p.resource] = result.entry;
    switch (result.outcome.kind) {
      case 'granted':
        deliverGrant(service, p.resource, result.outcome.grant, false, event.id);
        return;
      case 'queued':
        state.waitTimers[waitKey(p.resource, message.source, p.attempt)] = services.setTimer(
          service.id,
          MODULE,
          'wait',
          p.waitMs,
          { resource: p.resource, clientId: message.source, attempt: p.attempt },
          event.id,
        );
        services.emit(
          'LOCK_QUEUED',
          { serviceId: service.id, resource: p.resource, clientId: message.source, position: result.outcome.position, holder: result.entry.holder },
          { nodeId: service.id, causedBy: event.id },
        );
        return;
      case 'refused':
        refuse(service, p.resource, message.source, p.attempt, result.outcome.reason, event.id);
        return;
    }
  };

  const refuse = (service: SimNode, resource: string, clientId: NodeId, attempt: number, reason: LockRefusePayload['reason'], causedBy: EventId) => {
    services.emit('LOCK_DENIED', { serviceId: service.id, resource, clientId, reason }, { nodeId: service.id, causedBy });
    const payload: LockRefusePayload = { resource, attempt, reason };
    send(service.id, clientId, 'LOCK_REFUSE', payload, causedBy);
  };

  const onRenew = (service: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const p = message.payload as LockRenewPayload;
    const state = serviceOf(service.id);
    const result = renewLease(state.locks[p.resource] ?? FREE_LOCK, message.source, p.token, now());
    if (result.renewed) {
      state.locks[p.resource] = result.entry;
      freeLock(service, p.resource);
      state.leaseTimers[p.resource] = services.setTimer(service.id, MODULE, 'lease', result.entry.leaseMs, { resource: p.resource, token: p.token }, event.id);
      services.emit(
        'LOCK_RENEWED',
        { serviceId: service.id, resource: p.resource, holder: message.source, token: p.token, leaseMs: result.entry.leaseMs },
        { nodeId: service.id, causedBy: event.id },
      );
    }
    const payload: LockRenewResultPayload = { resource: p.resource, token: p.token, ok: result.renewed };
    send(service.id, message.source, 'LOCK_RENEW_RESULT', payload, event.id);
  };

  const onRelease = (service: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const p = message.payload as LockReleasePayload;
    const state = serviceOf(service.id);
    const before = state.locks[p.resource] ?? FREE_LOCK;
    const result = releaseLock(before, message.source, p.token);
    if (!result.released) return;
    state.locks[p.resource] = result.entry;
    freeLock(service, p.resource);
    services.emit(
      'LOCK_RELEASED',
      { serviceId: service.id, resource: p.resource, holder: message.source, token: p.token, heldMs: now() - before.heldSince },
      { nodeId: service.id, causedBy: event.id },
    );
    handOn(service, p.resource, event.id);
  };

  const onLeaseTimer = (service: SimNode, event: SimEvent<'TIMER'>) => {
    const resource = String(event.payload.data!.resource);
    const token = Number(event.payload.data!.token);
    const state = serviceOf(service.id);
    if (state.leaseTimers[resource] !== event.id) return;
    delete state.leaseTimers[resource];
    const before = state.locks[resource] ?? FREE_LOCK;
    const result = expireLease(before, token, now());
    if (!result.expired) return;
    state.locks[resource] = result.entry;
    services.emit(
      'LOCK_EXPIRED',
      { serviceId: service.id, resource, holder: before.holder as NodeId, token, heldMs: now() - before.heldSince },
      { nodeId: service.id, causedBy: event.id },
    );
    handOn(service, resource, event.id);
  };

  const onWaitTimer = (service: SimNode, event: SimEvent<'TIMER'>) => {
    const data = event.payload.data!;
    const resource = String(data.resource);
    const clientId = String(data.clientId);
    const attempt = Number(data.attempt);
    const state = serviceOf(service.id);
    const key = waitKey(resource, clientId, attempt);
    if (state.waitTimers[key] !== event.id) return;
    delete state.waitTimers[key];
    const result = removeWaiter(state.locks[resource] ?? FREE_LOCK, clientId, attempt);
    if (!result.removed) return;
    state.locks[resource] = result.entry;
    refuse(service, resource, clientId, attempt, 'wait_timeout', event.id);
  };

  // --- lock client ---------------------------------------------------------

  const clientPolicy = (node: SimNode): LockClientPolicy | undefined => node.config.lockClient;
  const sample = (node: SimNode, spec: Parameters<typeof sampleLatency>[0]) => sampleLatency(spec, services.rng(MODULE, node.id));

  const armStep = (node: SimNode, name: string, delay: number, causedBy?: EventId) => {
    const state = clientOf(node.id);
    if (state.timer !== undefined) services.cancelTimer(state.timer);
    state.timer = services.setTimer(node.id, MODULE, name, delay, { attempt: state.attempt }, causedBy);
  };

  const stopRenewing = (state: ClientState) => {
    if (state.renewTimer !== undefined) services.cancelTimer(state.renewTimer);
    state.renewTimer = undefined;
  };

  const think = (node: SimNode, policy: LockClientPolicy, causedBy: EventId) => {
    const state = clientOf(node.id);
    state.phase = 'idle';
    stopRenewing(state);
    armStep(node, 'start', sample(node, policy.thinkMs ?? DEFAULT_THINK_MS), causedBy);
  };

  /** The client stops believing it holds the lock. */
  const endCriticalSection = (node: SimNode, policy: LockClientPolicy, outcome: CriticalSectionOutcome, causedBy: EventId) => {
    const state = clientOf(node.id);
    services.emit(
      'CRITICAL_SECTION_ENDED',
      { clientId: node.id, resource: policy.resource, token: state.token, outcome, heldMs: now() - state.acquiredAt },
      { nodeId: node.id, causedBy },
    );
  };

  const finish = (node: SimNode, policy: LockClientPolicy, outcome: CriticalSectionOutcome, causedBy: EventId) => {
    const state = clientOf(node.id);
    endCriticalSection(node, policy, outcome, causedBy);
    // Releasing a lease already lost is harmless — the service ignores an old token — and saves waiting for it to expire otherwise.
    const payload: LockReleasePayload = { resource: policy.resource, token: state.token };
    send(node.id, policy.service, 'LOCK_RELEASE', payload, causedBy);
    think(node, policy, causedBy);
  };

  const ask = (node: SimNode, policy: LockClientPolicy, causedBy: EventId) => {
    const state = clientOf(node.id);
    state.attempt += 1;
    state.phase = 'waiting';
    state.requestedAt = now();
    const waitMs = policy.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    const payload: LockAcquirePayload = { resource: policy.resource, leaseMs: policy.leaseMs ?? DEFAULT_LEASE_MS, waitMs, attempt: state.attempt };
    services.emit(
      'LOCK_REQUESTED',
      { clientId: node.id, serviceId: policy.service, resource: policy.resource, attempt: state.attempt },
      { nodeId: node.id, causedBy },
    );
    send(node.id, policy.service, 'LOCK_ACQUIRE', payload, causedBy);
    armStep(node, 'give_up', waitMs + ANSWER_MARGIN_MS, causedBy);
  };

  const onGrant = (node: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const policy = clientPolicy(node);
    const p = message.payload as LockGrantPayload;
    const state = clientOf(node.id);
    if (!policy || state.phase !== 'waiting' || p.attempt !== state.attempt) {
      // A grant for a request it already gave up on: hand it straight back rather than block everyone until it expires.
      const payload: LockReleasePayload = { resource: p.resource, token: p.token };
      send(node.id, message.source, 'LOCK_RELEASE', payload, event.id);
      return;
    }
    state.phase = 'holding';
    state.token = p.token;
    state.acquiredAt = now();
    state.leaseUntil = state.requestedAt + p.leaseMs;
    services.emit(
      'CRITICAL_SECTION_STARTED',
      { clientId: node.id, serviceId: message.source, resource: p.resource, token: p.token },
      { nodeId: node.id, causedBy: event.id },
    );
    armStep(node, 'work', sample(node, policy.holdMs ?? DEFAULT_HOLD_MS), event.id);
    const renewEvery = renewIntervalOf(policy);
    if (renewEvery > 0) state.renewTimer = services.setTimer(node.id, MODULE, 'renew', renewEvery, { token: p.token }, event.id);
  };

  const onRefuse = (node: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const policy = clientPolicy(node);
    const p = message.payload as LockRefusePayload;
    const state = clientOf(node.id);
    if (!policy || state.phase !== 'waiting' || p.attempt !== state.attempt) return;
    think(node, policy, event.id);
  };

  const onRenewResult = (node: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const policy = clientPolicy(node);
    const p = message.payload as LockRenewResultPayload;
    const state = clientOf(node.id);
    if (!policy || p.token !== state.token || (state.phase !== 'holding' && state.phase !== 'writing')) return;
    if (p.ok) {
      state.leaseUntil = Math.max(state.leaseUntil, state.renewSentAt + (policy.leaseMs ?? DEFAULT_LEASE_MS));
      return;
    }
    // The service says the lease is gone. Too late to recall a write already sent; otherwise, stop before writing.
    if (state.phase === 'writing') return;
    if (state.timer !== undefined) services.cancelTimer(state.timer);
    state.timer = undefined;
    endCriticalSection(node, policy, 'lost_lease', event.id);
    think(node, policy, event.id);
  };

  const onWriteResult = (node: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const policy = clientPolicy(node);
    const p = message.payload as FencedWriteResultPayload;
    const state = clientOf(node.id);
    if (!policy || state.phase !== 'writing' || p.attempt !== state.attempt) return;
    finish(node, policy, p.accepted ? 'completed' : 'fenced', event.id);
  };

  const onClientTimer = (node: SimNode, policy: LockClientPolicy, event: SimEvent<'TIMER'>) => {
    const state = clientOf(node.id);
    if (event.payload.name === 'renew') {
      if (state.renewTimer !== event.id) return;
      state.renewTimer = undefined;
      if (state.phase !== 'holding' && state.phase !== 'writing') return;
      state.renewSentAt = now();
      const payload: LockRenewPayload = { resource: policy.resource, token: state.token };
      send(node.id, policy.service, 'LOCK_RENEW', payload, event.id);
      state.renewTimer = services.setTimer(node.id, MODULE, 'renew', renewIntervalOf(policy), { token: state.token }, event.id);
      return;
    }
    if (state.timer !== event.id) return;
    state.timer = undefined;
    switch (event.payload.name) {
      case 'start':
        if (state.phase === 'idle') ask(node, policy, event.id);
        return;
      case 'give_up':
        if (state.phase !== 'waiting') return;
        services.emit(
          'LOCK_DENIED',
          { serviceId: policy.service, resource: policy.resource, clientId: node.id, reason: 'gave_up' },
          { nodeId: node.id, causedBy: event.id },
        );
        think(node, policy, event.id);
        return;
      case 'work': {
        if (state.phase !== 'holding') return;
        if (policy.checkLeaseBeforeWrite && now() >= state.leaseUntil) {
          endCriticalSection(node, policy, 'lost_lease', event.id);
          think(node, policy, event.id);
          return;
        }
        if (policy.storage === undefined) {
          finish(node, policy, 'completed', event.id);
          return;
        }
        state.phase = 'writing';
        const payload: FencedWritePayload = { resource: policy.resource, token: state.token, attempt: state.attempt };
        send(node.id, policy.storage, 'FENCED_WRITE', payload, event.id);
        armStep(node, 'write_timeout', WRITE_TIMEOUT_MS, event.id);
        return;
      }
      case 'write_timeout':
        if (state.phase === 'writing') finish(node, policy, 'write_unconfirmed', event.id);
        return;
    }
  };

  // --- storage ---------------------------------------------------------------

  const onFencedWrite = (node: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const p = message.payload as FencedWritePayload;
    const delay = sampleLatency(node.config.writeLatency ?? node.config.processing, services.rng(MODULE, node.id));
    services.setTimer(node.id, MODULE, 'apply_write', delay, { resource: p.resource, token: p.token, attempt: p.attempt, writer: message.source }, event.id);
  };

  const applyWrite = (node: SimNode, event: SimEvent<'TIMER'>) => {
    const data = event.payload.data!;
    const resource = String(data.resource);
    const token = Number(data.token);
    const writer = String(data.writer);
    const key = `${node.id}|${resource}`;
    const record = storage.get(key) ?? { highestToken: 0, highestWriter: null };
    const stale = checkFencingToken(record.highestToken, token) === 'stale';
    const detail = { storageId: node.id, resource, token, writer, highestToken: record.highestToken, highestWriter: record.highestWriter };
    let accepted = true;
    if (stale && node.config.fencing) {
      accepted = false;
      services.emit('FENCED_WRITE_REJECTED', detail, { nodeId: node.id, causedBy: event.id });
    } else {
      if (stale) services.emit('SAFETY_VIOLATION', detail, { nodeId: node.id, causedBy: event.id });
      services.emit('FENCED_WRITE_ACCEPTED', { storageId: node.id, resource, token, writer }, { nodeId: node.id, causedBy: event.id });
      if (token >= record.highestToken) storage.set(key, { highestToken: token, highestWriter: writer });
    }
    const payload: FencedWriteResultPayload = { resource, token, attempt: Number(data.attempt), accepted, highestToken: record.highestToken };
    send(node.id, writer, 'FENCED_WRITE_RESULT', payload, event.id);
  };

  return {
    name: MODULE,
    messageKinds: [
      'LOCK_ACQUIRE',
      'LOCK_GRANT',
      'LOCK_REFUSE',
      'LOCK_RENEW',
      'LOCK_RENEW_RESULT',
      'LOCK_RELEASE',
      'FENCED_WRITE',
      'FENCED_WRITE_RESULT',
    ],
    servesNodeTypes: ['lock_service'],

    attach(on) {
      on('SIMULATION_STARTED', (event) => {
        for (const node of services.registry.all()) {
          const policy = clientPolicy(node);
          if (policy && node.state.status !== 'failed') armStep(node, 'start', policy.startAt ?? 0, event.id);
        }
      });
    },

    onMessage(node, message, event) {
      switch (message.kind) {
        case 'LOCK_ACQUIRE':
          if (node.type === 'lock_service') onAcquire(node, message, event);
          return;
        case 'LOCK_RENEW':
          if (node.type === 'lock_service') onRenew(node, message, event);
          return;
        case 'LOCK_RELEASE':
          if (node.type === 'lock_service') onRelease(node, message, event);
          return;
        case 'LOCK_GRANT':
          return onGrant(node, message, event);
        case 'LOCK_REFUSE':
          return onRefuse(node, message, event);
        case 'LOCK_RENEW_RESULT':
          return onRenewResult(node, message, event);
        case 'FENCED_WRITE':
          return onFencedWrite(node, message, event);
        case 'FENCED_WRITE_RESULT':
          return onWriteResult(node, message, event);
        case 'REQUEST':
          // A lock service is not a place to send application work.
          services.reply(node, message as RequestMessage, 'error', undefined, event.id);
          return;
        default:
          return;
      }
    },

    onTimer(node, event) {
      switch (event.payload.name) {
        case 'lease':
          return onLeaseTimer(node, event);
        case 'wait':
          return onWaitTimer(node, event);
        case 'grace_over': {
          const state = serviceOf(node.id);
          if (state.graceTimer !== event.id) return;
          state.graceTimer = undefined;
          for (const resource of Object.keys(state.locks).sort()) handOn(node, resource, event.id);
          return;
        }
        case 'apply_write':
          return applyWrite(node, event);
        default: {
          const policy = clientPolicy(node);
          if (policy) onClientTimer(node, policy, event);
        }
      }
    },

    onNodeFailed(node, event) {
      if (node.type === 'lock_service') {
        // The lock table was in memory: holders, waiters and leases are gone.
        // The token counters are kept — they must never go backwards, or
        // fencing would let an old holder through — as if written to disk.
        const state = serviceOf(node.id);
        for (const resource of Object.keys(state.locks)) {
          const entry = state.locks[resource]!;
          state.locks[resource] = { ...FREE_LOCK, token: entry.token };
        }
        state.leaseTimers = {};
        state.waitTimers = {};
        state.graceTimer = undefined;
      }
      const policy = clientPolicy(node);
      if (policy) {
        const state = clientOf(node.id);
        if (state.phase === 'holding' || state.phase === 'writing') endCriticalSection(node, policy, 'crashed', event.id);
        state.phase = 'idle';
        state.timer = undefined;
        state.renewTimer = undefined;
      }
    },

    onNodeRecovered(node, event) {
      if (node.type === 'lock_service') {
        const state = serviceOf(node.id);
        const policy = servicePolicy(node);
        const grace = policy.recoveryGraceMs ?? Math.max(policy.defaultLeaseMs ?? DEFAULT_LEASE_MS, state.maxLeaseMs);
        state.graceUntil = now() + grace;
        if (grace > 0) state.graceTimer = services.setTimer(node.id, MODULE, 'grace_over', grace, undefined, event.id);
      }
      const policy = clientPolicy(node);
      if (policy) armStep(node, 'start', sample(node, policy.thinkMs ?? DEFAULT_THINK_MS), event.id);
    },

    captureState(): LocksState {
      return {
        services: [...serviceStates.entries()].map(([id, s]) => [
          id,
          {
            ...s,
            locks: Object.fromEntries(Object.entries(s.locks).map(([k, e]) => [k, { ...e, waiters: [...e.waiters] }])),
            leaseTimers: { ...s.leaseTimers },
            waitTimers: { ...s.waitTimers },
          },
        ]),
        clients: [...clientStates.entries()].map(([id, c]) => [id, { ...c }]),
        storage: [...storage.entries()].map(([k, r]) => [k, { ...r }]),
      };
    },

    restoreState(raw) {
      const state = (raw ?? { services: [], clients: [], storage: [] }) as LocksState;
      serviceStates = new Map(
        state.services.map(([id, s]) => [
          id,
          {
            ...s,
            locks: Object.fromEntries(Object.entries(s.locks).map(([k, e]) => [k, { ...e, waiters: [...e.waiters] }])),
            leaseTimers: { ...s.leaseTimers },
            waitTimers: { ...s.waitTimers },
          },
        ]),
      );
      clientStates = new Map(state.clients.map(([id, c]) => [id, { ...c }]));
      storage = new Map(state.storage.map(([k, r]) => [k, { ...r }]));
    },
  };
}

/** Who holds each lock in each service's view, for inspection. */
export function lockHolders(module: SimModule): { serviceId: NodeId; resource: string; holder: NodeId | null; token: number; waiting: number }[] {
  const state = module.captureState() as LocksState;
  return state.services.flatMap(([serviceId, s]) =>
    Object.entries(s.locks).map(([resource, e]) => ({ serviceId, resource, holder: e.holder, token: e.token, waiting: e.waiters.length })),
  );
}
