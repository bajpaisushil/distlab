import { describe, expect, it } from 'vitest';
import {
  SPEC_VERSION,
  validateSimulationSpec,
  type FaultSpec,
  type LockClientPolicy,
  type NodeSpec,
  type SimulationSpec,
} from '@distlab/shared';
import { createSimulation, type SimulationWorld } from '../src/world.js';
import { expectReplayEquivalence } from './replay-harness.js';

interface Options {
  workers?: number;
  client?: Partial<LockClientPolicy>;
  /** Per-worker overrides, by index. */
  perWorker?: Record<number, Partial<LockClientPolicy>>;
  fencing?: boolean;
  service?: NodeSpec['config'];
  faults?: FaultSpec[];
  durationMs?: number;
  latency?: number;
}

/** A lock service, N workers contending for one lock, and the storage they write to. */
function lockSpec(options: Options = {}): SimulationSpec {
  const count = options.workers ?? 3;
  const workers = Array.from({ length: count }, (_, i) => `w${i + 1}`);
  const latency = options.latency ?? 2;
  return {
    version: SPEC_VERSION,
    id: 'locks',
    name: 'locks',
    seed: 'locks',
    durationMs: options.durationMs ?? 5000,
    nodes: [
      { id: 'locks', type: 'lock_service', ...(options.service ? { config: options.service } : {}) },
      { id: 'db', type: 'database', config: { writeLatency: 5, ...(options.fencing !== undefined ? { fencing: options.fencing } : {}) } },
      ...workers.map((id, i) => ({
        id,
        type: 'worker' as const,
        config: {
          lockClient: {
            service: 'locks',
            resource: 'invoice-42',
            storage: 'db',
            leaseMs: 500,
            renewEveryMs: 150,
            holdMs: 100,
            thinkMs: 50,
            startAt: i * 10,
            ...options.client,
            ...options.perWorker?.[i],
          },
        },
      })),
    ],
    links: workers.flatMap((id) => [
      { from: id, to: 'locks', latency },
      { from: id, to: 'db', latency },
    ]),
    workloads: [],
    ...(options.faults ? { faults: options.faults } : {}),
  };
}

function run(spec: SimulationSpec): SimulationWorld {
  const world = createSimulation(spec);
  world.run();
  return world;
}

const lockOf = (world: SimulationWorld) => world.snapshot().modules.locks.resources[0]!;

describe('distributed lock: contention', () => {
  it('grants one holder at a time with strictly rising fencing tokens', () => {
    const world = run(lockSpec());
    const log = world.simulation.log;
    const grants = log.byType('LOCK_ACQUIRED');
    expect(grants.length).toBeGreaterThan(20);
    const tokens = grants.map((e) => e.payload.token);
    expect(tokens).toEqual(tokens.map((_, i) => i + 1));

    // In the service's view, every grant follows the previous holder's release or expiry.
    const ends = [...log.byType('LOCK_RELEASED'), ...log.byType('LOCK_EXPIRED')];
    for (const grant of grants.slice(1)) {
      const previous = grant.payload.token - 1;
      const end = ends.find((e) => e.payload.token === previous);
      expect(end, `token ${previous} ended before token ${grant.payload.token}`).toBeDefined();
      expect(end!.at).toBeLessThanOrEqual(grant.at);
    }
    const lock = lockOf(world);
    expect(lock.safetyViolations).toBe(0);
    expect(lock.maxBelievedHolders).toBe(1);
    expect(lock.expirations).toBe(0);
  });

  it('serves waiters first come, first served, so every worker gets turns', () => {
    const lock = lockOf(run(lockSpec()));
    const turns = Object.values(lock.acquisitionsByClient);
    expect(turns).toHaveLength(3);
    expect(Math.max(...turns) - Math.min(...turns)).toBeLessThanOrEqual(1);
    expect(lock.wait.p95).toBeGreaterThan(100);
  });

  it('renews a lease to keep a critical section longer than the lease', () => {
    const world = run(lockSpec({ workers: 2, client: { holdMs: 2000, leaseMs: 500, renewEveryMs: 150 } }));
    const lock = lockOf(world);
    expect(lock.expirations).toBe(0);
    expect(lock.renewals).toBeGreaterThan(20);
    expect(lock.meanHoldMs).toBeGreaterThan(2000);
  });

  it('times out waiters that wait too long', () => {
    const world = run(lockSpec({ client: { holdMs: 1000, acquireTimeoutMs: 300 } }));
    const denied = world.simulation.log.byType('LOCK_DENIED');
    expect(denied.length).toBeGreaterThan(3);
    expect(denied.every((e) => e.payload.reason === 'wait_timeout')).toBe(true);
  });

  it('hands back a grant that arrives after the client stopped waiting', () => {
    // The grant takes 800ms to come back; the client gives up after 200 + 500.
    const world = run(lockSpec({ workers: 1, latency: 800, client: { acquireTimeoutMs: 200, leaseMs: 5000 }, durationMs: 3000 }));
    const log = world.simulation.log;
    expect(log.byType('LOCK_DENIED')[0]!.payload.reason).toBe('gave_up');
    expect(log.byType('CRITICAL_SECTION_STARTED')).toHaveLength(0);
    // Released straight back, long before its lease would have run out.
    expect(log.byType('LOCK_RELEASED')[0]!.payload.token).toBe(1);
    expect(log.byType('LOCK_EXPIRED')).toHaveLength(0);
  });
});

describe('distributed lock: a frozen holder', () => {
  // w1 takes the lock first, then freezes for a second — twice its lease.
  const frozen = (extra: Partial<Options> = {}) =>
    lockSpec({ client: { holdMs: 300 }, faults: [{ kind: 'node_pause', at: 100, nodeId: 'w1', durationMs: 1000 }], durationMs: 3000, ...extra });

  it('loses its lease at the service while it is frozen, and the lock moves on', () => {
    const world = run(frozen());
    const log = world.simulation.log;
    const expired = log.byType('LOCK_EXPIRED');
    expect(expired).toHaveLength(1);
    expect(expired[0]!.payload).toMatchObject({ holder: 'w1', token: 1 });
    const next = log.byType('LOCK_ACQUIRED').find((e) => e.payload.token === 2)!;
    expect(next.payload.holder).not.toBe('w1');
    expect(next.at).toBe(expired[0]!.at);
  });

  it('wakes believing it still holds the lock and overwrites newer data — without fencing', () => {
    const world = run(frozen());
    const log = world.simulation.log;
    const [violation] = log.byType('SAFETY_VIOLATION');
    expect(violation).toBeDefined();
    expect(violation!.payload).toMatchObject({ writer: 'w1', token: 1 });
    expect(violation!.payload.highestToken).toBeGreaterThan(1);
    expect(violation!.at).toBeGreaterThan(1100);
    const lock = lockOf(world);
    expect(lock.safetyViolations).toBe(1);
    // Two clients believed they held the lock at once.
    expect(lock.maxBelievedHolders).toBe(2);
  });

  it('is stopped by storage that checks fencing tokens', () => {
    const world = run(frozen({ fencing: true }));
    const log = world.simulation.log;
    expect(log.byType('SAFETY_VIOLATION')).toHaveLength(0);
    const [rejected] = log.byType('FENCED_WRITE_REJECTED');
    expect(rejected!.payload).toMatchObject({ writer: 'w1', token: 1 });
    const ended = log.byType('CRITICAL_SECTION_ENDED').find((e) => e.payload.clientId === 'w1' && e.payload.token === 1)!;
    expect(ended.payload.outcome).toBe('fenced');
    expect(lockOf(world).fencedRejections).toBe(1);
  });

  it('is caught by a lease check before writing — when the freeze lands before the check', () => {
    const world = run(frozen({ client: { holdMs: 300, checkLeaseBeforeWrite: true } }));
    const log = world.simulation.log;
    expect(log.byType('SAFETY_VIOLATION')).toHaveLength(0);
    const ended = log.byType('CRITICAL_SECTION_ENDED').find((e) => e.payload.clientId === 'w1' && e.payload.token === 1)!;
    expect(ended.payload.outcome).toBe('lost_lease');
    expect(log.byType('FENCED_WRITE_ACCEPTED').some((e) => e.payload.writer === 'w1' && e.payload.token === 1)).toBe(false);
  });

  it('survives checkpoints taken mid-freeze', () => {
    expectReplayEquivalence(frozen(), { fractions: [0.05, 0.15, 0.3, 0.6] });
  });
});

describe('distributed lock: failures', () => {
  it('frees a crashed holder’s lock when its lease runs out', () => {
    const world = run(lockSpec({ client: { holdMs: 300 }, faults: [{ kind: 'node_crash', at: 100, nodeId: 'w1', recoverAfter: 1000 }] }));
    const log = world.simulation.log;
    const ended = log.byType('CRITICAL_SECTION_ENDED').find((e) => e.payload.clientId === 'w1')!;
    expect(ended.payload.outcome).toBe('crashed');
    const expired = log.byType('LOCK_EXPIRED')[0]!;
    expect(expired.payload.holder).toBe('w1');
    // Nobody could take the lock until the lease ran out.
    expect(log.byType('LOCK_ACQUIRED').filter((e) => e.at > 100 && e.at < expired.at)).toHaveLength(0);
    // The recovered worker rejoins the rotation.
    expect(log.byType('LOCK_ACQUIRED').some((e) => e.payload.holder === 'w1' && e.at > 1100)).toBe(true);
  });

  it('keeps tokens rising across a lock-service restart and waits out old leases first', () => {
    const world = run(lockSpec({ faults: [{ kind: 'node_crash', at: 1000, nodeId: 'locks', recoverAfter: 300 }] }));
    const log = world.simulation.log;
    const grants = log.byType('LOCK_ACQUIRED');
    const tokens = grants.map((e) => e.payload.token);
    expect(tokens).toEqual([...tokens].sort((a, b) => a - b));
    expect(new Set(tokens).size).toBe(tokens.length);
    // Recovered at 1300; nothing granted during the grace period of one default lease.
    expect(grants.filter((e) => e.at >= 1000 && e.at < 2300)).toHaveLength(0);
    expect(grants.filter((e) => e.at >= 2300).length).toBeGreaterThan(5);
  });

  // w1 holds a long, unrenewed lease when the service restarts; the others keep asking.
  const restart = (service: NodeSpec['config'] = {}) =>
    lockSpec({
      client: { holdMs: 1000, leaseMs: 2000, renewEveryMs: 0, acquireTimeoutMs: 100 },
      service,
      faults: [{ kind: 'node_crash', at: 100, nodeId: 'locks', recoverAfter: 50 }],
    });

  it('waits out the longest lease it granted after a restart, so the old holder finishes first', () => {
    const world = run(restart());
    expect(lockOf(world).maxBelievedHolders).toBe(1);
    expect(world.simulation.log.byType('LOCK_ACQUIRED').filter((e) => e.at > 100 && e.at < 2150)).toHaveLength(0);
  });

  it('can be told to skip the grace period — and then grants a lock someone still believes they hold', () => {
    const world = run(restart({ lockService: { recoveryGraceMs: 0 } }));
    expect(lockOf(world).maxBelievedHolders).toBe(2);
  });

  it('never routes application requests to a lock service', () => {
    const spec: SimulationSpec = {
      ...lockSpec({ workers: 1 }),
      nodes: [...lockSpec({ workers: 1 }).nodes, { id: 'client', type: 'client' }, { id: 'api', type: 'api' }],
      links: [...lockSpec({ workers: 1 }).links, { from: 'client', to: 'api', latency: 1 }, { from: 'api', to: 'locks', latency: 1 }],
      workloads: [{ id: 'w', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'constant', ratePerSec: 10 } }],
    };
    const log = run(spec).simulation.log;
    expect(log.byType('REQUEST_ROUTED').some((e) => e.payload.to === 'locks')).toBe(false);
  });
});

describe('lock validation', () => {
  const errors = (spec: SimulationSpec) => validateSimulationSpec(spec).errors.map((e) => e.path);

  it('accepts a well-formed lock setup', () => {
    expect(errors(lockSpec())).toEqual([]);
  });

  it('rejects a lock client without a service, link or sane renewal', () => {
    const base = lockSpec({ workers: 1 });
    expect(errors({ ...base, links: base.links.filter((l) => l.to !== 'locks') })).toContain('nodes[2].config.lockClient.service');
    expect(errors(lockSpec({ workers: 1, client: { service: 'db' } }))).toContain('nodes[2].config.lockClient.service');
    expect(errors(lockSpec({ workers: 1, client: { renewEveryMs: 600 } }))).toContain('nodes[2].config.lockClient.renewEveryMs');
    expect(errors(lockSpec({ workers: 1, client: { resource: '' } }))).toContain('nodes[2].config.lockClient.resource');
  });

  it('keeps settings on the right node types', () => {
    const base = lockSpec({ workers: 1 });
    const misplaced: SimulationSpec = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'db' ? { ...n, config: { ...n.config, lockService: { defaultLeaseMs: 100 } } } : n)),
    };
    expect(errors(misplaced)).toContain('nodes[1].config.lockService');
  });
});
