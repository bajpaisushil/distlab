import { describe, expect, it } from 'vitest';
import { FAULT_KINDS, NODE_TYPES } from '@distlab/shared';
import { createSimulation } from '@distlab/simulation-engine';
import { findScenario } from '@distlab/scenarios';
import {
  ANALYSIS_SYSTEM,
  SCENARIO_SYSTEM,
  SPEC_REFERENCE,
  buildEvidence,
  checkAnalysis,
  checkExperiment,
  checkScenario,
  renderEvidence,
  unsupportedNumbers,
  type EvidencePack,
} from '../src/index.js';
import { measured, configured, type Explanation } from '../src/types.js';

const spec = findScenario('web-service')!.spec;
const world = createSimulation(spec);
world.run();
const snapshot = world.snapshot();
const explanation: Explanation = {
  title: 'Request failed at t=1.20s',
  summary: 'The database was saturated.',
  facts: [measured('It waited 1200ms in db\'s queue of 32.', 'e1', 'e2'), configured('db allows 8 concurrent requests.')],
  interpretation: [],
  suggestions: [],
};
const pack = buildEvidence({ spec, snapshot, explanation, question: '  Why did it fail?  ' });

describe('evidence pack', () => {
  it('numbers every item and keeps the configuration, facts and metrics apart', () => {
    expect(pack.items[0]!.id).toBe('SCENARIO');
    expect(pack.items.filter((i) => i.id.startsWith('F')).map((i) => i.id)).toEqual(['F1', 'F2']);
    expect(pack.items.some((i) => i.id === 'M1' && i.kind === 'measured')).toBe(true);
    expect(pack.items.find((i) => i.id === 'F1')!.eventIds).toEqual(['e1', 'e2']);
    expect(pack.question).toBe('Why did it fail?');
  });

  it('renders exactly what will be sent, deterministically', () => {
    const text = renderEvidence(pack);
    expect(text).toContain('[SCENARIO] (configured)');
    expect(text).toContain('[F1] (measured) It waited 1200ms');
    expect(text).toContain('Question: Why did it fail?');
    expect(renderEvidence(buildEvidence({ spec, snapshot, explanation, question: 'Why did it fail?' }))).toBe(text);
    // Only the scenario, the simulator's own facts and metrics — event ids stay local.
    expect(text).not.toContain('e1');
  });

  it('reports subsystem metrics only for subsystems the scenario uses', () => {
    const locks = findScenario('lock-contention')!.spec;
    const lockWorld = createSimulation(locks);
    lockWorld.run();
    const text = renderEvidence(buildEvidence({ spec: locks, snapshot: lockWorld.snapshot(), explanation: undefined, question: '' }));
    expect(text).toContain('Lock "invoice-42"');
    expect(text).toContain('1 safety violations');
    expect(text).not.toContain('requests issued');
    expect(text).not.toContain('Raft cluster');
  });
});

describe('grounding checks', () => {
  const answer = (claims: unknown[], summary = 'The database queue was the bottleneck.') => checkAnalysis({ summary, claims, suggestions: ['What if db had 16 slots?'] }, pack);

  it('accepts a measured claim whose numbers are in what it cites, in any unit', () => {
    const result = answer([{ text: 'The request queued for 1.2s at the database.', basis: 'measured', cites: ['F1'] }]);
    expect(result.ok && result.value.claims[0]!.status).toBe('grounded');
    expect(result.ok && result.value.claims[0]!.eventIds).toEqual(['e1', 'e2']);
  });

  it('flags a number the cited evidence does not contain', () => {
    const result = answer([{ text: 'It waited 4500ms.', basis: 'measured', cites: ['F1'] }]);
    expect(result.ok && result.value.claims[0]).toMatchObject({ status: 'unverified', problem: '4500 is not in the evidence it cites' });
  });

  it('flags claims that cite nothing, or evidence that does not exist', () => {
    const result = answer([
      { text: 'The database was busy.', basis: 'measured', cites: [] },
      { text: 'The database was busy.', basis: 'configured', cites: ['F9'] },
    ]);
    expect(result.ok && result.value.claims.map((c) => c.status)).toEqual(['unverified', 'unverified']);
    expect(result.ok && result.value.claims[1]!.problem).toContain('F9');
  });

  it('labels interpretation as such, unless it smuggles in a number', () => {
    const result = answer([
      { text: 'More database concurrency would probably help.', basis: 'interpretation', cites: [] },
      { text: 'Raising it to 9137 slots would fix it.', basis: 'interpretation', cites: [] },
    ]);
    expect(result.ok && result.value.claims.map((c) => c.status)).toEqual(['interpretation', 'unverified']);
  });

  it('flags invented numbers in the summary', () => {
    const result = answer([], 'Latency rose by 912ms.');
    expect(result.ok && result.value.summaryProblem).toContain('912');
  });

  it('treats numbers inside names as names', () => {
    expect(unsupportedNumbers('api-1 and n3 sent p99 traffic at t16', 'nothing')).toEqual([]);
    expect(unsupportedNumbers('about 0.95 of requests', 'success rate 95%')).toEqual([]);
    expect(unsupportedNumbers('1,200 requests', 'issued 1200 requests')).toEqual([]);
  });

  it('rejects answers of the wrong shape', () => {
    expect(checkAnalysis({ summary: 1 }, pack).ok).toBe(false);
    expect(checkAnalysis('nope', pack as EvidencePack).ok).toBe(false);
  });
});

describe('experiment proposals', () => {
  const change = (overrides: Record<string, unknown>) => ({
    kind: 'set_node',
    nodeId: null,
    linkId: null,
    field: null,
    valueJson: null,
    factor: null,
    faultJson: null,
    seed: null,
    durationMs: null,
    ...overrides,
  });

  it('turns a valid proposal into a validated variant of the scenario', () => {
    const result = checkExperiment(
      {
        name: 'More database slots',
        question: 'What if the database had twice the concurrency?',
        hypothesis: 'Fewer requests wait in the queue.',
        changes: [change({ nodeId: 'db', field: 'concurrency', valueJson: '16' }), change({ kind: 'scale_traffic', factor: 1.5 })],
      },
      spec,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.issues).toEqual([]);
    expect(result.value.variant!.nodes.find((n) => n.id === 'db')!.config!.concurrency).toBe(16);
  });

  it('refuses unknown nodes, forbidden fields and malformed values instead of guessing', () => {
    const result = checkExperiment(
      {
        name: 'Bad',
        question: '',
        hypothesis: '',
        changes: [
          change({ nodeId: 'nope', field: 'concurrency', valueJson: '16' }),
          change({ nodeId: 'db', field: 'id', valueJson: '"x"' }),
        ],
      },
      spec,
    );
    expect(result.ok && result.value.variant).toBeUndefined();
    expect(result.ok && result.value.issues.length).toBeGreaterThanOrEqual(2);

    const broken = checkExperiment({ name: 'x', changes: [change({ nodeId: 'db', field: 'concurrency', valueJson: '{oops' })] }, spec);
    expect(broken.ok && broken.value.issues[0]!.message).toBe('is not valid JSON');
  });

  it('adds a fault only if the fault itself validates', () => {
    const good = checkExperiment(
      { name: 'Crash', changes: [change({ kind: 'add_fault', faultJson: JSON.stringify({ kind: 'node_crash', at: 2000, nodeId: 'db' }) })] },
      spec,
    );
    expect(good.ok && good.value.variant?.faults).toHaveLength((spec.faults ?? []).length + 1);
    const bad = checkExperiment({ name: 'Crash', changes: [change({ kind: 'add_fault', faultJson: JSON.stringify({ kind: 'node_crash', at: 2000, nodeId: 'ghost' }) })] }, spec);
    expect(bad.ok && bad.value.variant).toBeUndefined();
  });
});

describe('generated scenarios', () => {
  it('accepts a scenario that validates, exactly as an import would', () => {
    const result = checkScenario({ summary: 'A web tier.', specJson: JSON.stringify(spec) });
    expect(result.ok && result.value.spec?.id).toBe(spec.id);
  });

  it('reports why one does not', () => {
    const invalid = checkScenario({ summary: '', specJson: JSON.stringify({ ...spec, nodes: [] }) });
    expect(invalid.ok && invalid.value.spec).toBeUndefined();
    expect(invalid.ok && invalid.value.issues.length).toBeGreaterThan(0);
    expect(checkScenario({ summary: '', specJson: 'not json' }).ok && true).toBe(true);
  });
});

describe('prompts', () => {
  it('describe every node type and fault kind the engine supports', () => {
    for (const type of NODE_TYPES) expect(SPEC_REFERENCE).toContain(`"${type}"`);
    for (const kind of FAULT_KINDS) expect(SPEC_REFERENCE).toContain(kind);
    expect(SCENARIO_SYSTEM).toContain(SPEC_REFERENCE);
  });

  it('forbid invented numbers', () => {
    expect(ANALYSIS_SYSTEM).toContain('Never invent a number');
  });
});
