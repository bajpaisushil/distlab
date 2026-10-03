import { describe, expect, it } from 'vitest';
import { Rng, SPEC_VERSION, validateSimulationSpec, type FaultSpec, type LinkSpec, type NodeSpec, type SimulationSpec } from '@distlab/shared';
import { createSimulation, type SimulationWorld } from '../src/world.js';
import { raftRoles } from '../src/modules/consensus.js';
import { expectReplayEquivalence } from './replay-harness.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${i + 1}`);

function cluster(options: {
  size?: number;
  seed?: string;
  durationMs?: number;
  consensus?: Record<string, unknown>;
  faults?: FaultSpec[];
  writes?: number;
  link?: Partial<LinkSpec>;
}): SimulationSpec {
  const members = ids(options.size ?? 5);
  const nodes: NodeSpec[] = members.map((id) => ({ id, type: 'consensus', config: { consensus: options.consensus ?? {} } }));
  const links: LinkSpec[] = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) links.push({ from: members[i]!, to: members[j]!, latency: 5, ...options.link });
  }
  const withClient = options.writes !== undefined;
  if (withClient) {
    nodes.push(
      { id: 'client', type: 'client' },
      {
        id: 'lb',
        type: 'load_balancer',
        config: { processing: 1, retry: { maxRetries: 4, backoff: 'none', retryOn: ['not_leader', 'timeout', 'unreachable'] }, callTimeoutMs: 300 },
      },
    );
    links.push({ from: 'client', to: 'lb', latency: 2 }, ...members.map((m) => ({ from: 'lb', to: m, latency: 2 })));
  }
  return {
    version: SPEC_VERSION,
    id: 'raft',
    name: 'raft',
    seed: options.seed ?? 'raft',
    durationMs: options.durationMs ?? 3000,
    nodes,
    links,
    workloads: withClient
      ? [{ id: 'writes', clientId: 'client', operation: 'HTTP_POST', arrival: { kind: 'poisson', ratePerSec: options.writes! }, deadlineMs: 1500, startAt: 500 }]
      : [],
    ...(options.faults ? { faults: options.faults } : {}),
  };
}

const run = (s: SimulationSpec): SimulationWorld => {
  const world = createSimulation(s);
  world.run();
  return world;
};

function assertSafety(world: SimulationWorld): void {
  const log = world.simulation.log;
  // Election safety: at most one leader per term.
  const leadersByTerm = new Map<number, Set<string>>();
  for (const e of log.byType('LEADER_ELECTED')) {
    leadersByTerm.set(e.payload.term, (leadersByTerm.get(e.payload.term) ?? new Set()).add(e.payload.leaderId));
  }
  for (const [term, leaders] of leadersByTerm) expect(leaders.size, `two leaders in term ${term}`).toBe(1);
  // State machine safety: whatever is committed at an index is the same everywhere, forever.
  const committed = new Map<number, string>();
  for (const e of log.byType('LOG_COMMITTED')) {
    const value = `${e.payload.term}:${e.payload.command}`;
    const previous = committed.get(e.payload.index);
    if (previous !== undefined) expect(value, `index ${e.payload.index} committed twice differently`).toBe(previous);
    committed.set(e.payload.index, value);
  }
  // Leader completeness: every committed entry is in every later leader's log.
  const finalLogs = (world.modules.get('consensus')!.captureState() as [string, { log: { index: number; term: number; command: string }[] }][]);
  const lastLeader = log.byType('LEADER_ELECTED').at(-1);
  if (lastLeader) {
    const leaderLog = finalLogs.find(([id]) => id === lastLeader.payload.leaderId)![1].log;
    for (const [index, value] of committed) {
      const entry = leaderLog[index - 1];
      expect(entry && `${entry.term}:${entry.command}`, `leader ${lastLeader.payload.leaderId} lost committed index ${index}`).toBe(value);
    }
  }
}

describe('leader election', () => {
  it('elects exactly one leader that everyone follows', () => {
    const world = run(cluster({}));
    const elected = world.simulation.log.byType('LEADER_ELECTED');
    expect(elected).toHaveLength(1);
    const leader = elected[0]!.payload.leaderId;
    expect(elected[0]!.payload.votes).toBeGreaterThanOrEqual(3);
    const roles = raftRoles(world.modules.get('consensus')!);
    expect(roles.filter((r) => r.role === 'leader').map((r) => r.nodeId)).toEqual([leader]);
    expect(new Set(roles.map((r) => r.term)).size).toBe(1);
    expect(roles.every((r) => r.leaderId === leader)).toBe(true);
  });

  it('elects a new leader in a higher term when the leader dies', () => {
    const first = run(cluster({ durationMs: 1000 })).simulation.log.byType('LEADER_ELECTED')[0]!.payload;
    const world = run(cluster({ durationMs: 3000, faults: [{ kind: 'node_crash', at: 1000, nodeId: first.leaderId }] }));
    const elected = world.simulation.log.byType('LEADER_ELECTED');
    expect(elected.length).toBeGreaterThanOrEqual(2);
    const next = elected.find((e) => e.at > 1000)!.payload;
    expect(next.leaderId).not.toBe(first.leaderId);
    expect(next.term).toBeGreaterThan(first.term);
    expect(world.simulation.log.byType('LEADER_ELECTED').find((e) => e.at > 1000)!.at).toBeLessThan(1000 + 300 + 100);
  });

  it('never elects anyone when election timeouts are not randomised — the vote splits forever', () => {
    const lockstep = run(cluster({ size: 4, consensus: { electionTimeoutMs: { min: 200, max: 200 } } }));
    expect(lockstep.simulation.log.byType('ELECTION_STARTED').length).toBeGreaterThan(20);
    expect(lockstep.simulation.log.byType('LEADER_ELECTED')).toHaveLength(0);

    const randomised = run(cluster({ size: 4, consensus: { electionTimeoutMs: { min: 150, max: 300 } } }));
    expect(randomised.simulation.log.byType('LEADER_ELECTED').length).toBeGreaterThan(0);
  });
});

describe('log replication', () => {
  it('commits client writes through the leader; followers redirect', () => {
    const world = run(cluster({ writes: 40, durationMs: 4000 }));
    const log = world.simulation.log;
    const committed = log.byType('LOG_COMMITTED').filter((e) => e.payload.command.startsWith('r-'));
    const completed = log.byType('REQUEST_COMPLETED');
    expect(completed.length).toBeGreaterThan(100);
    expect(committed.length).toBeGreaterThanOrEqual(completed.length);
    // Some requests first hit a follower and were redirected by a retry.
    expect(log.byType('RETRY').some((e) => e.payload.reason === 'not_leader')).toBe(true);
    for (const e of committed) expect(e.payload.replicatedTo).toBeGreaterThanOrEqual(3);
    assertSafety(world);
  });
});

describe('split brain', () => {
  it('lets a partitioned old leader believe it leads, but never commit', () => {
    const first = run(cluster({ durationMs: 1000 })).simulation.log.byType('LEADER_ELECTED')[0]!.payload;
    const others = ids(5).filter((id) => id !== first.leaderId);
    const minority = [first.leaderId, others[0]!];
    const majority = others.slice(1);
    const world = run(
      cluster({
        durationMs: 5000,
        writes: 30,
        faults: [{ kind: 'partition', at: 1000, groups: [minority, [...majority, 'lb', 'client']], healAfter: 2000 }],
      }),
    );
    const log = world.simulation.log;
    const newLeader = log.byType('LEADER_ELECTED').find((e) => e.at > 1000 && e.at < 3000)!;
    expect(majority).toContain(newLeader.payload.leaderId);
    expect(newLeader.payload.term).toBeGreaterThan(first.term);
    // The old leader stays leader of its old term throughout the partition…
    const stepDown = log.byType('STEPPED_DOWN').find((e) => e.payload.nodeId === first.leaderId && e.payload.from === 'leader')!;
    expect(stepDown.at).toBeGreaterThanOrEqual(3000);
    expect(stepDown.payload.reason).toBe('higher_term');
    // …but commits nothing during it.
    const oldLeaderCommits = log
      .byType('LOG_COMMITTED')
      .filter((e) => e.payload.leaderId === first.leaderId && e.at > 1050 && e.at < 3000);
    expect(oldLeaderCommits).toHaveLength(0);
    assertSafety(world);
  });
});

describe('safety under chaos', () => {
  it('holds election safety and log safety across many seeds with crashes and partitions', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rng = new Rng(`chaos-${seed}`);
      const members = ids(5);
      const faults: FaultSpec[] = [];
      for (let i = 0; i < 4; i++) {
        const at = rng.int(300, 4000);
        if (rng.bool(0.5)) faults.push({ kind: 'node_crash', at, nodeId: rng.pick(members), recoverAfter: rng.int(100, 1500) });
        else {
          const shuffled = rng.shuffle(members);
          const cut = rng.int(1, 4);
          faults.push({ kind: 'partition', id: `p${i}`, at, groups: [shuffled.slice(0, cut), shuffled.slice(cut)], healAfter: rng.int(200, 1500) });
        }
      }
      const world = run(cluster({ seed: `chaos-${seed}`, durationMs: 5000, writes: 25, faults, link: { lossRate: 0.02 } }));
      assertSafety(world);
    }
  });
});

describe('consensus configuration', () => {
  it('requires every pair of members to be linked, and sane timers', () => {
    const s = cluster({ size: 3, consensus: { heartbeatIntervalMs: 500, electionTimeoutMs: { min: 300, max: 100 } } });
    s.links = s.links.slice(1);
    const errors = validateSimulationSpec(s).errors;
    expect(errors.some((e) => e.path === 'links' && /n1 and n2/.test(e.message))).toBe(true);
    expect(errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(['nodes[0].config.consensus.electionTimeoutMs', 'nodes[0].config.consensus.heartbeatIntervalMs']),
    );
  });
});

describe('consensus checkpoints', () => {
  it('replays an election, a crash and a partition exactly', () => {
    expectReplayEquivalence(
      cluster({
        durationMs: 3000,
        writes: 30,
        link: { latency: { kind: 'uniform', min: 2, max: 9 } as never, lossRate: 0.02 },
        faults: [
          { kind: 'node_crash', at: 900, nodeId: 'n2', recoverAfter: 600 },
          { kind: 'partition', at: 1800, groups: [['n1', 'n3'], ['n2', 'n4', 'n5']], healAfter: 500 },
        ],
      }),
    );
  });
});
