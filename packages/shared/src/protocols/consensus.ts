/**
 * Raft-like consensus contracts.
 *
 * An educational simulation of leader election and log replication in the
 * style of Raft — not a production implementation. It keeps the rules that
 * make Raft safe (terms, one vote per term, the up-to-date log check, the log
 * consistency check, majority commit of current-term entries) and leaves out
 * membership changes, snapshots and log compaction.
 */
import type { NodeId, RequestId } from '../ids.js';
import { checkPositive, type IssueReporter, type SpecValidationContext } from '../validation.js';

export interface ConsensusPolicy {
  /** Nodes sharing a cluster id form one cluster. Default "raft". */
  clusterId?: string;
  /** Followers wait a random time in this range without hearing from a leader before standing. Default 150–300ms. */
  electionTimeoutMs?: { min: number; max: number };
  /** How often a leader asserts itself. Default 50ms; must be well under the election timeout. */
  heartbeatIntervalMs?: number;
}

export interface ConsensusNodeConfig {
  consensus?: ConsensusPolicy;
}

export const DEFAULT_CLUSTER_ID = 'raft';
export const DEFAULT_ELECTION_TIMEOUT = { min: 150, max: 300 };
export const DEFAULT_HEARTBEAT_MS = 50;

export type RaftRole = 'follower' | 'candidate' | 'leader';

export interface RaftEntry {
  readonly term: number;
  readonly index: number;
  /** The client request that created it, or "noop" for a new leader's first entry. */
  readonly command: string;
}

export type ConsensusMessageKind = 'RAFT_REQUEST_VOTE' | 'RAFT_VOTE' | 'RAFT_APPEND_ENTRIES' | 'RAFT_APPEND_RESPONSE';

export interface RaftRequestVotePayload {
  readonly term: number;
  readonly candidateId: NodeId;
  readonly lastLogIndex: number;
  readonly lastLogTerm: number;
}

export interface RaftVotePayload {
  readonly term: number;
  readonly granted: boolean;
  readonly voterId: NodeId;
}

export interface RaftAppendEntriesPayload {
  readonly term: number;
  readonly leaderId: NodeId;
  readonly prevLogIndex: number;
  readonly prevLogTerm: number;
  readonly entries: readonly RaftEntry[];
  readonly leaderCommit: number;
}

export interface RaftAppendResponsePayload {
  readonly term: number;
  readonly success: boolean;
  /** On success, the last index known to match; on failure, a hint for where to retry. */
  readonly matchIndex: number;
  readonly followerId: NodeId;
}

export type ConsensusMessagePayload =
  | RaftRequestVotePayload
  | RaftVotePayload
  | RaftAppendEntriesPayload
  | RaftAppendResponsePayload;

export type VoteDeniedReason = 'stale_term' | 'already_voted' | 'log_behind';

export interface ConsensusEventPayloads {
  ELECTION_STARTED: { nodeId: NodeId; clusterId: string; term: number; timeoutMs: number };
  VOTE_REQUESTED: { candidateId: NodeId; voterId: NodeId; term: number };
  VOTE_GRANTED: { candidateId: NodeId; voterId: NodeId; term: number };
  VOTE_DENIED: { candidateId: NodeId; voterId: NodeId; term: number; reason: VoteDeniedReason; votedFor?: NodeId };
  LEADER_ELECTED: {
    clusterId: string;
    leaderId: NodeId;
    term: number;
    votes: number;
    clusterSize: number;
    electionDurationMs: number;
  };
  /** A leader or candidate went back to being a follower. */
  STEPPED_DOWN: {
    nodeId: NodeId;
    clusterId: string;
    from: 'leader' | 'candidate';
    term: number;
    newTerm: number;
    reason: 'higher_term' | 'leader_found';
  };
  LOG_APPENDED: { nodeId: NodeId; index: number; term: number; command: string; requestId?: RequestId };
  LOG_COMMITTED: { leaderId: NodeId; clusterId: string; index: number; term: number; command: string; replicatedTo: number };
}

export function validateConsensusConfig(
  config: ConsensusNodeConfig,
  path: string,
  push: IssueReporter,
  context: SpecValidationContext,
): void {
  const raw = config as Record<string, unknown>;
  if (raw.consensus === undefined) return;
  const consensus = raw.consensus as Record<string, unknown>;
  const at = `${path}.consensus`;
  if (typeof consensus !== 'object' || consensus === null) {
    push(at, 'must be an object');
    return;
  }
  if (context.self && context.self.type !== 'consensus') push(at, 'only consensus nodes take consensus settings');
  if (consensus.clusterId !== undefined && (typeof consensus.clusterId !== 'string' || consensus.clusterId.length === 0)) {
    push(`${at}.clusterId`, 'must be a non-empty string');
  }
  const timeout = consensus.electionTimeoutMs as Record<string, unknown> | undefined;
  if (timeout !== undefined) {
    checkPositive(timeout.min, `${at}.electionTimeoutMs.min`, push, false);
    checkPositive(timeout.max, `${at}.electionTimeoutMs.max`, push, false);
    if (typeof timeout.min === 'number' && typeof timeout.max === 'number' && timeout.min > timeout.max) {
      push(`${at}.electionTimeoutMs`, 'min must not exceed max');
    }
  }
  checkPositive(consensus.heartbeatIntervalMs, `${at}.heartbeatIntervalMs`, push, true);
  const min = typeof timeout?.min === 'number' ? timeout.min : DEFAULT_ELECTION_TIMEOUT.min;
  const heartbeat = typeof consensus.heartbeatIntervalMs === 'number' ? consensus.heartbeatIntervalMs : DEFAULT_HEARTBEAT_MS;
  if (heartbeat >= min) {
    push(`${at}.heartbeatIntervalMs`, 'must be shorter than the minimum election timeout, or followers will keep starting elections');
  }
}
