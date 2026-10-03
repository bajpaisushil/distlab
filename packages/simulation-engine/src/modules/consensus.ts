import { appendEntries, candidateIsUpToDate, commitIndexFor, lastIndex, lastTerm, quorum, termAt } from '@distlab/algorithms';
import {
  DEFAULT_CLUSTER_ID,
  DEFAULT_ELECTION_TIMEOUT,
  DEFAULT_HEARTBEAT_MS,
  type EventId,
  type Message,
  type NodeId,
  type RaftAppendEntriesPayload,
  type RaftAppendResponsePayload,
  type RaftEntry,
  type RaftRequestVotePayload,
  type RaftRole,
  type RaftVotePayload,
  type RequestMessage,
  type SimEvent,
  type SimNode,
  type VoteDeniedReason,
} from '@distlab/shared';
import type { ModuleServices, SimModule } from './types.js';

const MODULE = 'consensus';
/** Entries sent in one AppendEntries. */
const BATCH = 64;

interface RaftState {
  // Persistent: survives a crash (it would be on disk).
  currentTerm: number;
  votedFor: NodeId | null;
  log: RaftEntry[];
  // Volatile.
  role: RaftRole;
  leaderId: NodeId | null;
  commitIndex: number;
  votes: NodeId[];
  electionStartedAt: number;
  electionTimer: EventId | undefined;
  heartbeatTimer: EventId | undefined;
  nextIndex: Record<NodeId, number>;
  matchIndex: Record<NodeId, number>;
  /** Leader only: client requests waiting for their entry to commit, by log index. */
  pending: Record<number, RequestMessage>;
}

/**
 * An educational, Raft-like consensus cluster — not a production Raft.
 *
 * Every consensus node is a follower until it hears nothing from a leader for
 * a randomised election timeout; then it becomes a candidate, votes for itself
 * in a new term and asks its peers. A peer grants at most one vote per term,
 * and only to a candidate whose log is at least as up to date as its own.
 * A majority makes a leader, which asserts itself with heartbeats and
 * replicates its log with the consistency check, committing an entry once a
 * majority holds it and it is from the leader's own term. Any message with a
 * higher term turns its receiver back into a follower.
 *
 * All of it travels through the simulated network, so partitions, loss and
 * delay act on it exactly as on application traffic: a leader cut off from
 * the majority keeps believing it leads, but can commit nothing.
 *
 * Clients write by sending a request to any member: the leader answers once
 * the write commits; anyone else answers "not_leader" with a hint.
 * Left out on purpose: membership changes, snapshots, log compaction.
 */
export function createConsensusModule(services: ModuleServices): SimModule {
  let nodes = new Map<NodeId, RaftState>();

  const now = () => services.context.now();
  const policyOf = (node: SimNode) => node.config.consensus ?? {};
  const clusterOf = (node: SimNode) => policyOf(node).clusterId ?? DEFAULT_CLUSTER_ID;

  /** Every member of a node's cluster, including itself, in id order. */
  const membersOf = (node: SimNode): NodeId[] =>
    services.registry
      .all()
      .filter((n) => n.type === 'consensus' && clusterOf(n) === clusterOf(node))
      .map((n) => n.id)
      .sort();
  const peersOf = (node: SimNode) => membersOf(node).filter((id) => id !== node.id);

  const stateOf = (id: NodeId): RaftState => {
    let state = nodes.get(id);
    if (!state) {
      state = {
        currentTerm: 0,
        votedFor: null,
        log: [],
        role: 'follower',
        leaderId: null,
        commitIndex: 0,
        votes: [],
        electionStartedAt: 0,
        electionTimer: undefined,
        heartbeatTimer: undefined,
        nextIndex: {},
        matchIndex: {},
        pending: {},
      };
      nodes.set(id, state);
    }
    return state;
  };

  const send = (from: SimNode, to: NodeId, kind: Message['kind'], payload: Message['payload'], causedBy?: EventId) => {
    services.send({
      kind,
      source: from.id,
      destination: to,
      type: kind,
      payload,
      sizeBytes: kind === 'RAFT_APPEND_ENTRIES' ? 128 + 64 * (payload as RaftAppendEntriesPayload).entries.length : 96,
      hop: 0,
      ...(causedBy !== undefined ? { causedBy } : {}),
    });
  };

  const armElectionTimer = (node: SimNode, causedBy?: EventId) => {
    const state = stateOf(node.id);
    if (state.electionTimer !== undefined) services.cancelTimer(state.electionTimer);
    const range = policyOf(node).electionTimeoutMs ?? DEFAULT_ELECTION_TIMEOUT;
    // Randomised so that followers rarely time out together and split the vote.
    const timeout = services.rng(MODULE, node.id).range(range.min, range.max);
    state.electionTimer = services.setTimer(node.id, MODULE, 'election', timeout, { timeout }, causedBy);
  };

  const armHeartbeat = (node: SimNode, causedBy?: EventId) => {
    const state = stateOf(node.id);
    if (state.heartbeatTimer !== undefined) services.cancelTimer(state.heartbeatTimer);
    state.heartbeatTimer = services.setTimer(node.id, MODULE, 'heartbeat', policyOf(node).heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS, undefined, causedBy);
  };

  /** Back to follower — on seeing a higher term, or a legitimate leader for our term. */
  const stepDown = (node: SimNode, newTerm: number, reason: 'higher_term' | 'leader_found', causedBy: EventId) => {
    const state = stateOf(node.id);
    const oldTerm = state.currentTerm;
    if (newTerm > state.currentTerm) {
      state.currentTerm = newTerm;
      state.votedFor = null;
    }
    if (state.role !== 'follower') {
      services.emit(
        'STEPPED_DOWN',
        { nodeId: node.id, clusterId: clusterOf(node), from: state.role, term: oldTerm, newTerm: state.currentTerm, reason },
        { nodeId: node.id, causedBy },
      );
      if (state.role === 'leader') {
        if (state.heartbeatTimer !== undefined) services.cancelTimer(state.heartbeatTimer);
        state.heartbeatTimer = undefined;
        // Writes this node accepted but never committed: it can no longer promise them.
        for (const request of Object.values(state.pending)) {
          services.reply(node, request, 'not_leader', state.leaderId ? { leaderHint: state.leaderId } : undefined, causedBy);
        }
        state.pending = {};
      }
      state.role = 'follower';
    }
    armElectionTimer(node, causedBy);
  };

  const startElection = (node: SimNode, event: SimEvent<'TIMER'>) => {
    const state = stateOf(node.id);
    if (state.role === 'leader') return;
    state.currentTerm += 1;
    state.role = 'candidate';
    state.votedFor = node.id;
    state.votes = [node.id];
    state.leaderId = null;
    state.electionStartedAt = now();
    services.emit(
      'ELECTION_STARTED',
      { nodeId: node.id, clusterId: clusterOf(node), term: state.currentTerm, timeoutMs: Number(event.payload.data?.timeout ?? 0) },
      { nodeId: node.id, causedBy: event.id },
    );
    armElectionTimer(node, event.id);
    const members = membersOf(node);
    if (state.votes.length >= quorum(members.length)) {
      becomeLeader(node, event.id);
      return;
    }
    const request: RaftRequestVotePayload = {
      term: state.currentTerm,
      candidateId: node.id,
      lastLogIndex: lastIndex(state.log),
      lastLogTerm: lastTerm(state.log),
    };
    for (const peer of peersOf(node)) {
      services.emit('VOTE_REQUESTED', { candidateId: node.id, voterId: peer, term: state.currentTerm }, { nodeId: node.id, causedBy: event.id });
      send(node, peer, 'RAFT_REQUEST_VOTE', request, event.id);
    }
  };

  const onRequestVote = (node: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const request = message.payload as RaftRequestVotePayload;
    const state = stateOf(node.id);
    if (request.term > state.currentTerm) stepDown(node, request.term, 'higher_term', event.id);

    let denied: VoteDeniedReason | undefined;
    if (request.term < state.currentTerm) denied = 'stale_term';
    else if (state.votedFor !== null && state.votedFor !== request.candidateId) denied = 'already_voted';
    else if (!candidateIsUpToDate(request.lastLogTerm, request.lastLogIndex, state.log)) denied = 'log_behind';

    if (denied === undefined) {
      state.votedFor = request.candidateId;
      // Granting a vote is hearing from a viable leader-to-be: hold off our own candidacy.
      armElectionTimer(node, event.id);
      services.emit('VOTE_GRANTED', { candidateId: request.candidateId, voterId: node.id, term: state.currentTerm }, { nodeId: node.id, causedBy: event.id });
    } else {
      services.emit(
        'VOTE_DENIED',
        {
          candidateId: request.candidateId,
          voterId: node.id,
          term: state.currentTerm,
          reason: denied,
          ...(denied === 'already_voted' && state.votedFor !== null ? { votedFor: state.votedFor } : {}),
        },
        { nodeId: node.id, causedBy: event.id },
      );
    }
    const vote: RaftVotePayload = { term: state.currentTerm, granted: denied === undefined, voterId: node.id };
    send(node, request.candidateId, 'RAFT_VOTE', vote, event.id);
  };

  const onVote = (node: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const vote = message.payload as RaftVotePayload;
    const state = stateOf(node.id);
    if (vote.term > state.currentTerm) {
      stepDown(node, vote.term, 'higher_term', event.id);
      return;
    }
    if (state.role !== 'candidate' || vote.term !== state.currentTerm || !vote.granted) return;
    if (!state.votes.includes(vote.voterId)) state.votes.push(vote.voterId);
    if (state.votes.length >= quorum(membersOf(node).length)) becomeLeader(node, event.id);
  };

  const becomeLeader = (node: SimNode, causedBy: EventId) => {
    const state = stateOf(node.id);
    state.role = 'leader';
    state.leaderId = node.id;
    if (state.electionTimer !== undefined) services.cancelTimer(state.electionTimer);
    state.electionTimer = undefined;
    const members = membersOf(node);
    services.emit(
      'LEADER_ELECTED',
      {
        clusterId: clusterOf(node),
        leaderId: node.id,
        term: state.currentTerm,
        votes: state.votes.length,
        clusterSize: members.length,
        electionDurationMs: now() - state.electionStartedAt,
      },
      { nodeId: node.id, causedBy },
    );
    // A no-op entry from the new term lets earlier-term entries commit (Raft §8).
    append(node, 'noop', undefined, causedBy);
    state.nextIndex = {};
    state.matchIndex = {};
    for (const peer of peersOf(node)) {
      state.nextIndex[peer] = lastIndex(state.log);
      state.matchIndex[peer] = 0;
    }
    replicateAll(node, causedBy);
    armHeartbeat(node, causedBy);
    advanceCommit(node, causedBy);
  };

  const append = (node: SimNode, command: string, request: RequestMessage | undefined, causedBy: EventId) => {
    const state = stateOf(node.id);
    const entry: RaftEntry = { term: state.currentTerm, index: lastIndex(state.log) + 1, command };
    state.log.push(entry);
    if (request) state.pending[entry.index] = request;
    services.emit(
      'LOG_APPENDED',
      { nodeId: node.id, index: entry.index, term: entry.term, command, ...(request ? { requestId: request.requestId } : {}) },
      { nodeId: node.id, ...(request ? { traceId: request.traceId } : {}), causedBy },
    );
  };

  const replicateTo = (node: SimNode, peer: NodeId, causedBy?: EventId) => {
    const state = stateOf(node.id);
    const next = Math.max(1, state.nextIndex[peer] ?? lastIndex(state.log) + 1);
    const prevLogIndex = next - 1;
    const payload: RaftAppendEntriesPayload = {
      term: state.currentTerm,
      leaderId: node.id,
      prevLogIndex,
      prevLogTerm: termAt(state.log, prevLogIndex),
      entries: state.log.slice(prevLogIndex, prevLogIndex + BATCH),
      leaderCommit: state.commitIndex,
    };
    send(node, peer, 'RAFT_APPEND_ENTRIES', payload, causedBy);
  };

  const replicateAll = (node: SimNode, causedBy?: EventId) => {
    for (const peer of peersOf(node)) replicateTo(node, peer, causedBy);
  };

  const onAppendEntries = (node: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const request = message.payload as RaftAppendEntriesPayload;
    const state = stateOf(node.id);
    const reply = (success: boolean, matchIndex: number) => {
      const response: RaftAppendResponsePayload = { term: state.currentTerm, success, matchIndex, followerId: node.id };
      send(node, request.leaderId, 'RAFT_APPEND_RESPONSE', response, event.id);
    };
    if (request.term < state.currentTerm) {
      // A deposed leader still sending: the reply's higher term will make it step down.
      reply(false, 0);
      return;
    }
    if (request.term > state.currentTerm || state.role !== 'follower') {
      stepDown(node, request.term, request.term > state.currentTerm ? 'higher_term' : 'leader_found', event.id);
    } else {
      armElectionTimer(node, event.id);
    }
    state.leaderId = request.leaderId;

    const result = appendEntries(state.log, request.prevLogIndex, request.prevLogTerm, request.entries);
    if (!result.ok) {
      reply(false, result.hint);
      return;
    }
    state.log = result.log;
    if (request.leaderCommit > state.commitIndex) {
      state.commitIndex = Math.min(request.leaderCommit, result.matchIndex);
    }
    reply(true, result.matchIndex);
  };

  const onAppendResponse = (node: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const response = message.payload as RaftAppendResponsePayload;
    const state = stateOf(node.id);
    if (response.term > state.currentTerm) {
      stepDown(node, response.term, 'higher_term', event.id);
      return;
    }
    if (state.role !== 'leader' || response.term !== state.currentTerm) return;
    const peer = response.followerId;
    if (response.success) {
      state.matchIndex[peer] = Math.max(state.matchIndex[peer] ?? 0, response.matchIndex);
      state.nextIndex[peer] = (state.matchIndex[peer] ?? 0) + 1;
      advanceCommit(node, event.id);
      // More to send: keep the follower moving without waiting for the next heartbeat.
      if ((state.nextIndex[peer] ?? 0) <= lastIndex(state.log)) replicateTo(node, peer, event.id);
    } else {
      state.nextIndex[peer] = Math.max(1, Math.min((state.nextIndex[peer] ?? 1) - 1, response.matchIndex + 1));
      replicateTo(node, peer, event.id);
    }
  };

  const advanceCommit = (node: SimNode, causedBy: EventId) => {
    const state = stateOf(node.id);
    const members = membersOf(node);
    const committed = commitIndexFor(
      state.log,
      state.currentTerm,
      state.commitIndex,
      peersOf(node).map((p) => state.matchIndex[p] ?? 0),
      members.length,
    );
    for (let index = state.commitIndex + 1; index <= committed; index++) {
      const entry = state.log[index - 1]!;
      const replicatedTo = 1 + peersOf(node).filter((p) => (state.matchIndex[p] ?? 0) >= index).length;
      services.emit(
        'LOG_COMMITTED',
        { leaderId: node.id, clusterId: clusterOf(node), index, term: entry.term, command: entry.command, replicatedTo },
        { nodeId: node.id, causedBy },
      );
      const request = state.pending[index];
      if (request) {
        delete state.pending[index];
        services.reply(node, request, 'ok', { leaderHint: node.id }, causedBy);
      }
    }
    state.commitIndex = committed;
  };

  const onClientRequest = (node: SimNode, request: RequestMessage, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const state = stateOf(node.id);
    if (state.role !== 'leader') {
      services.reply(node, request, 'not_leader', state.leaderId ? { leaderHint: state.leaderId } : undefined, event.id);
      return;
    }
    node.state.processed += 1;
    append(node, request.requestId, request, event.id);
    replicateAll(node, event.id);
    // A single-node cluster commits on its own.
    advanceCommit(node, event.id);
  };

  return {
    name: MODULE,
    messageKinds: ['RAFT_REQUEST_VOTE', 'RAFT_VOTE', 'RAFT_APPEND_ENTRIES', 'RAFT_APPEND_RESPONSE'],
    servesNodeTypes: ['consensus'],

    attach(on) {
      on('SIMULATION_STARTED', (event) => {
        for (const node of services.registry.all()) {
          if (node.type === 'consensus' && node.state.status !== 'failed') armElectionTimer(node, event.id);
        }
      });
    },

    onMessage(node, message, event) {
      switch (message.kind) {
        case 'RAFT_REQUEST_VOTE':
          return onRequestVote(node, message, event);
        case 'RAFT_VOTE':
          return onVote(node, message, event);
        case 'RAFT_APPEND_ENTRIES':
          return onAppendEntries(node, message, event);
        case 'RAFT_APPEND_RESPONSE':
          return onAppendResponse(node, message, event);
        case 'REQUEST':
          return onClientRequest(node, message as RequestMessage, event);
        default:
          return;
      }
    },

    onTimer(node, event) {
      const state = stateOf(node.id);
      if (event.payload.name === 'election') {
        if (state.electionTimer !== event.id) return;
        state.electionTimer = undefined;
        startElection(node, event);
      } else if (event.payload.name === 'heartbeat') {
        if (state.heartbeatTimer !== event.id || state.role !== 'leader') return;
        state.heartbeatTimer = undefined;
        replicateAll(node, event.id);
        armHeartbeat(node, event.id);
      }
    },

    onNodeFailed(node) {
      if (node.type !== 'consensus') return;
      // Term, vote and log are on disk; everything else was in memory.
      const state = stateOf(node.id);
      state.role = 'follower';
      state.leaderId = null;
      state.commitIndex = 0;
      state.votes = [];
      state.electionTimer = undefined;
      state.heartbeatTimer = undefined;
      state.nextIndex = {};
      state.matchIndex = {};
      state.pending = {};
    },

    onNodeRecovered(node, event) {
      if (node.type === 'consensus') armElectionTimer(node, event.id);
    },

    captureState() {
      return [...nodes.entries()].map(([id, s]) => [
        id,
        {
          ...s,
          log: [...s.log],
          votes: [...s.votes],
          nextIndex: { ...s.nextIndex },
          matchIndex: { ...s.matchIndex },
          pending: { ...s.pending },
        },
      ]);
    },

    restoreState(raw) {
      const entries = (raw ?? []) as [NodeId, RaftState][];
      nodes = new Map(
        entries.map(([id, s]) => [
          id,
          { ...s, log: [...s.log], votes: [...s.votes], nextIndex: { ...s.nextIndex }, matchIndex: { ...s.matchIndex }, pending: { ...s.pending } },
        ]),
      );
    },
  };
}

/** Current role and term of every consensus node, for inspection. */
export function raftRoles(module: SimModule): { nodeId: NodeId; role: RaftRole; term: number; leaderId: NodeId | null; logLength: number; commitIndex: number }[] {
  const state = module.captureState() as [NodeId, RaftState][];
  return state.map(([nodeId, s]) => ({ nodeId, role: s.role, term: s.currentTerm, leaderId: s.leaderId, logLength: s.log.length, commitIndex: s.commitIndex }));
}
