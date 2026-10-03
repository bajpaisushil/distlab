import type { SimEvent } from '@distlab/shared';
import type { MetricsRegistry } from '../metrics.js';
import type { TelemetryModule } from './types.js';

export interface LeadershipInterval {
  readonly leaderId: string;
  readonly term: number;
  readonly from: number;
  readonly to: number | null;
}

export interface ClusterTelemetry {
  readonly clusterId: string;
  readonly leader: string | null;
  readonly term: number;
  readonly elections: number;
  readonly leadersElected: number;
  /** Terms in which an election started but nobody won. */
  readonly failedElections: number;
  readonly commits: number;
  /** Total time with no leader. */
  readonly unavailableMs: number;
  /** Most nodes that believed they were leader at the same moment (2+ is split brain, if only in belief). */
  readonly maxBelievedLeaders: number;
  readonly believedLeaders: readonly { readonly t: number; readonly value: number }[];
  readonly terms: readonly { readonly t: number; readonly value: number }[];
  readonly leadership: readonly LeadershipInterval[];
}

export interface ConsensusNodeTelemetry {
  readonly nodeId: string;
  readonly clusterId: string;
  readonly role: 'follower' | 'candidate' | 'leader' | 'down';
  readonly term: number;
  /** Believes it leads, but a newer term has another leader — a stale leader. */
  readonly stale: boolean;
}

export interface ConsensusTelemetry {
  readonly clusters: readonly ClusterTelemetry[];
  readonly nodes: readonly ConsensusNodeTelemetry[];
}

const believers = (metrics: MetricsRegistry, cluster: string) => metrics.set(`consensus.believers.${cluster}`);

export const consensusTelemetry: TelemetryModule<ConsensusTelemetry> = {
  name: 'consensus',
  levels: {
    ELECTION_STARTED: 'info',
    VOTE_REQUESTED: 'debug',
    VOTE_GRANTED: 'debug',
    VOTE_DENIED: 'debug',
    LEADER_ELECTED: 'info',
    STEPPED_DOWN: 'warn',
    LOG_APPENDED: 'debug',
    LOG_COMMITTED: 'debug',
  },
  describe(event) {
    switch (event.type) {
      case 'ELECTION_STARTED': {
        const p = (event as SimEvent<'ELECTION_STARTED'>).payload;
        return `${p.nodeId} heard no leader for ${Math.round(p.timeoutMs)}ms and stood for election in term ${p.term}`;
      }
      case 'VOTE_REQUESTED': {
        const p = (event as SimEvent<'VOTE_REQUESTED'>).payload;
        return `${p.candidateId} asked ${p.voterId} for its term-${p.term} vote`;
      }
      case 'VOTE_GRANTED': {
        const p = (event as SimEvent<'VOTE_GRANTED'>).payload;
        return `${p.voterId} voted for ${p.candidateId} in term ${p.term}`;
      }
      case 'VOTE_DENIED': {
        const p = (event as SimEvent<'VOTE_DENIED'>).payload;
        const why = { stale_term: 'its term is stale', already_voted: `already voted for ${p.votedFor ?? 'someone else'}`, log_behind: 'its log is behind' }[p.reason];
        return `${p.voterId} refused ${p.candidateId} in term ${p.term}: ${why}`;
      }
      case 'LEADER_ELECTED': {
        const p = (event as SimEvent<'LEADER_ELECTED'>).payload;
        return `${p.leaderId} won term ${p.term} with ${p.votes} of ${p.clusterSize} votes after ${Math.round(p.electionDurationMs)}ms`;
      }
      case 'STEPPED_DOWN': {
        const p = (event as SimEvent<'STEPPED_DOWN'>).payload;
        return `${p.nodeId} stopped being ${p.from} (term ${p.term} → ${p.newTerm}): ${p.reason === 'higher_term' ? 'saw a higher term' : 'found the leader'}`;
      }
      case 'LOG_APPENDED': {
        const p = (event as SimEvent<'LOG_APPENDED'>).payload;
        return `${p.nodeId} appended entry ${p.index} (term ${p.term}): ${p.command}`;
      }
      case 'LOG_COMMITTED': {
        const p = (event as SimEvent<'LOG_COMMITTED'>).payload;
        return `${p.leaderId} committed entry ${p.index} (term ${p.term}), held by ${p.replicatedTo} nodes`;
      }
      default:
        return undefined;
    }
  },
  record(event, metrics) {
    const member = (nodeId: string, cluster: string) => {
      metrics.set('consensus.clusters').add(cluster);
      metrics.set('consensus.members').add(`${cluster}|${nodeId}`);
    };
    const setRole = (nodeId: string, role: string, term?: number) => {
      metrics.timeline(`consensus.role.${nodeId}`).record(event.at, role);
      if (term !== undefined) metrics.timeline(`consensus.node_term.${nodeId}`).record(event.at, term);
    };
    const clusterOfNode = (nodeId: string) =>
      [...metrics.set('consensus.members').values()].find((m) => m.endsWith(`|${nodeId}`))?.split('|')[0];
    const leaderGone = (cluster: string, nodeId: string) => {
      const set = believers(metrics, cluster);
      set.delete(nodeId);
      metrics.timeline(`consensus.believed.${cluster}`).record(event.at, set.size);
      const leader = metrics.timeline(`consensus.leader.${cluster}`);
      if (leader.last === nodeId) leader.record(event.at, null);
    };
    switch (event.type) {
      case 'ELECTION_STARTED': {
        const p = (event as SimEvent<'ELECTION_STARTED'>).payload;
        member(p.nodeId, p.clusterId);
        metrics.counter(`consensus.elections.${p.clusterId}`).add();
        metrics.set(`consensus.election_terms.${p.clusterId}`).add(String(p.term));
        metrics.timeline(`consensus.term.${p.clusterId}`).record(event.at, Math.max(p.term, Number(metrics.timeline(`consensus.term.${p.clusterId}`).last ?? 0)));
        setRole(p.nodeId, 'candidate', p.term);
        // Before anyone has led, there is no leader: start the clock at zero.
        const leader = metrics.timeline(`consensus.leader.${p.clusterId}`);
        if (leader.points().length === 0) leader.record(0, null);
        return;
      }
      case 'LEADER_ELECTED': {
        const p = (event as SimEvent<'LEADER_ELECTED'>).payload;
        member(p.leaderId, p.clusterId);
        metrics.counter(`consensus.leaders.${p.clusterId}`).add();
        metrics.set(`consensus.won_terms.${p.clusterId}`).add(String(p.term));
        metrics.timeline(`consensus.leader.${p.clusterId}`).record(event.at, p.leaderId);
        metrics.timeline(`consensus.leader_term.${p.clusterId}`).record(event.at, p.term);
        const set = believers(metrics, p.clusterId);
        set.add(p.leaderId);
        metrics.timeline(`consensus.believed.${p.clusterId}`).record(event.at, set.size);
        const peak = metrics.gauge(`consensus.max_believed.${p.clusterId}`);
        peak.set(Math.max(peak.max, set.size));
        setRole(p.leaderId, 'leader', p.term);
        return;
      }
      case 'STEPPED_DOWN': {
        const p = (event as SimEvent<'STEPPED_DOWN'>).payload;
        if (p.from === 'leader') leaderGone(p.clusterId, p.nodeId);
        setRole(p.nodeId, 'follower', p.newTerm);
        return;
      }
      case 'VOTE_GRANTED': {
        const p = (event as SimEvent<'VOTE_GRANTED'>).payload;
        metrics.timeline(`consensus.node_term.${p.voterId}`).record(event.at, p.term);
        return;
      }
      case 'LOG_COMMITTED': {
        const p = (event as SimEvent<'LOG_COMMITTED'>).payload;
        metrics.counter(`consensus.commits.${p.clusterId}`).add();
        return;
      }
      case 'NODE_FAILED': {
        const nodeId = (event as SimEvent<'NODE_FAILED'>).payload.nodeId;
        const cluster = clusterOfNode(nodeId);
        if (cluster === undefined) return;
        leaderGone(cluster, nodeId);
        setRole(nodeId, 'down');
        return;
      }
      case 'NODE_RECOVERED': {
        const nodeId = (event as SimEvent<'NODE_RECOVERED'>).payload.nodeId;
        if (clusterOfNode(nodeId) !== undefined) setRole(nodeId, 'follower');
        return;
      }
      default:
        return;
    }
  },
  snapshot(metrics, elapsedMs) {
    const clusters: ClusterTelemetry[] = [...metrics.set('consensus.clusters').values()].sort().map((clusterId) => {
      const leaderPoints = metrics.timeline(`consensus.leader.${clusterId}`).points();
      const termPoints = metrics.timeline(`consensus.leader_term.${clusterId}`).points();
      let unavailableMs = 0;
      const leadership: LeadershipInterval[] = [];
      leaderPoints.forEach((point, i) => {
        const end = leaderPoints[i + 1]?.t ?? null;
        if (point.value === null) unavailableMs += (end ?? elapsedMs) - point.t;
        else {
          const term = Number([...termPoints].reverse().find((t) => t.t <= point.t)?.value ?? 0);
          leadership.push({ leaderId: String(point.value), term, from: point.t, to: end });
        }
      });
      const electionTerms = metrics.set(`consensus.election_terms.${clusterId}`);
      const wonTerms = metrics.set(`consensus.won_terms.${clusterId}`);
      return {
        clusterId,
        leader: (metrics.timeline(`consensus.leader.${clusterId}`).last as string | null | undefined) ?? null,
        term: Number(metrics.timeline(`consensus.term.${clusterId}`).last ?? 0),
        elections: metrics.counter(`consensus.elections.${clusterId}`).total,
        leadersElected: metrics.counter(`consensus.leaders.${clusterId}`).total,
        failedElections: [...electionTerms.values()].filter((t) => !wonTerms.has(t)).length,
        commits: metrics.counter(`consensus.commits.${clusterId}`).total,
        unavailableMs,
        maxBelievedLeaders: metrics.gauge(`consensus.max_believed.${clusterId}`).max,
        believedLeaders: metrics.timeline(`consensus.believed.${clusterId}`).points().map((p) => ({ t: p.t, value: Number(p.value) })),
        terms: metrics.timeline(`consensus.term.${clusterId}`).points().map((p) => ({ t: p.t, value: Number(p.value) })),
        leadership,
      };
    });
    const nodes: ConsensusNodeTelemetry[] = [...metrics.set('consensus.members').values()].sort().map((key) => {
      const [clusterId, nodeId] = key.split('|') as [string, string];
      const role = (metrics.timeline(`consensus.role.${nodeId}`).last as ConsensusNodeTelemetry['role'] | undefined) ?? 'follower';
      const term = Number(metrics.timeline(`consensus.node_term.${nodeId}`).last ?? 0);
      const cluster = clusters.find((c) => c.clusterId === clusterId);
      const latestTerm = Number(metrics.timeline(`consensus.leader_term.${clusterId}`).last ?? 0);
      return { nodeId, clusterId, role, term, stale: role === 'leader' && cluster?.leader !== nodeId && term < latestTerm };
    });
    return { clusters, nodes };
  },
};
