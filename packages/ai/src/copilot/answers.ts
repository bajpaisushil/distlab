import { validateSimulationSpec, type SimulationSpec, type SpecIssue } from '@distlab/shared';
import { applyExperiment, type Experiment, type ExperimentChange } from '@distlab/scenarios';
import { SCENARIO_ITEM, type EvidencePack } from './evidence.js';

/**
 * What a model may answer, as JSON schemas for structured output, and the
 * checks every answer passes before anything is shown or offered to run.
 *
 * A model's words never touch the simulation. Claims are checked against the
 * evidence it was given; proposed experiments and scenarios go through the
 * same validation as anything a person types in, and only run when the
 * person chooses to.
 */

const nullable = (type: 'string' | 'number') => ({ anyOf: [{ type }, { type: 'null' }] });

export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'claims', 'suggestions'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences answering the question, consistent with the claims.' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'basis', 'cites'],
        properties: {
          text: { type: 'string' },
          basis: { type: 'string', enum: ['measured', 'configured', 'interpretation'] },
          cites: { type: 'array', items: { type: 'string' }, description: 'Evidence ids, such as F2, M1 or SCENARIO.' },
        },
      },
    },
    suggestions: { type: 'array', items: { type: 'string' }, description: 'Experiments worth running next, as questions.' },
  },
} as const;

export const EXPERIMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'question', 'hypothesis', 'changes'],
  properties: {
    name: { type: 'string', description: 'Short label, a few words.' },
    question: { type: 'string', description: 'The what-if question this experiment answers.' },
    hypothesis: { type: 'string', description: 'What you expect to change, stated as a prediction to be tested — not a result.' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'nodeId', 'linkId', 'field', 'valueJson', 'factor', 'faultJson', 'seed', 'durationMs'],
        properties: {
          kind: { type: 'string', enum: ['scale_traffic', 'set_node', 'set_link', 'set_all_links', 'add_fault', 'remove_faults', 'set_seed', 'set_duration'] },
          nodeId: nullable('string'),
          linkId: nullable('string'),
          field: nullable('string'),
          valueJson: { ...nullable('string'), description: 'The new value for set_node / set_link / set_all_links, as JSON text.' },
          factor: nullable('number'),
          faultJson: { ...nullable('string'), description: 'For add_fault: the fault as JSON text.' },
          seed: nullable('string'),
          durationMs: nullable('number'),
        },
      },
    },
  },
} as const;

export const SCENARIO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'specJson'],
  properties: {
    summary: { type: 'string', description: 'What the scenario shows and what to watch for.' },
    specJson: { type: 'string', description: 'The complete SimulationSpec as JSON text.' },
  },
} as const;

// --- analysis -----------------------------------------------------------------

export type ClaimBasis = 'measured' | 'configured' | 'interpretation';

export interface CheckedClaim {
  readonly text: string;
  readonly basis: ClaimBasis;
  readonly cites: readonly string[];
  /** grounded: every cited id exists and every number is in what it cites. */
  readonly status: 'grounded' | 'unverified' | 'interpretation';
  readonly problem?: string;
  /** Simulation events behind the cited evidence, to link to. */
  readonly eventIds: readonly string[];
}

export interface CheckedAnalysis {
  readonly summary: string;
  readonly summaryProblem?: string;
  readonly claims: readonly CheckedClaim[];
  readonly suggestions: readonly string[];
}

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** Checks every claim against the evidence it cites. Nothing is dropped: problems are shown beside the claim. */
export function checkAnalysis(raw: unknown, pack: EvidencePack): Checked<CheckedAnalysis> {
  if (!isObject(raw) || typeof raw.summary !== 'string' || !Array.isArray(raw.claims) || !Array.isArray(raw.suggestions)) {
    return { ok: false, error: 'The answer did not have the expected shape.' };
  }
  const byId = new Map(pack.items.map((item) => [item.id, item]));
  const everything = pack.items.map((item) => item.text).join('\n');

  const claims: CheckedClaim[] = [];
  for (const entry of raw.claims) {
    if (!isObject(entry) || typeof entry.text !== 'string' || !['measured', 'configured', 'interpretation'].includes(String(entry.basis))) continue;
    const basis = entry.basis as ClaimBasis;
    const cites = Array.isArray(entry.cites) ? entry.cites.filter((c): c is string => typeof c === 'string') : [];
    const known = cites.filter((c) => byId.has(c));
    const unknown = cites.filter((c) => !byId.has(c));
    const eventIds = [...new Set(known.flatMap((c) => byId.get(c)!.eventIds))];
    const base = { text: entry.text, basis, cites, eventIds };

    if (basis === 'interpretation') {
      const stray = unsupportedNumbers(entry.text, everything);
      claims.push(stray.length > 0 ? { ...base, status: 'unverified', problem: `uses ${stray.join(', ')}, which appears nowhere in the evidence` } : { ...base, status: 'interpretation' });
      continue;
    }
    if (known.length === 0) {
      claims.push({ ...base, status: 'unverified', problem: unknown.length > 0 ? `cites ${unknown.join(', ')}, which is not in the evidence` : 'cites no evidence' });
      continue;
    }
    const cited = known.map((c) => byId.get(c)!.text).join('\n');
    const stray = unsupportedNumbers(entry.text, cited);
    if (stray.length > 0) {
      claims.push({ ...base, status: 'unverified', problem: `${stray.join(', ')} is not in the evidence it cites` });
    } else if (unknown.length > 0) {
      claims.push({ ...base, status: 'unverified', problem: `also cites ${unknown.join(', ')}, which is not in the evidence` });
    } else {
      claims.push({ ...base, status: 'grounded' });
    }
  }
  const strayInSummary = unsupportedNumbers(raw.summary, everything);
  return {
    ok: true,
    value: {
      summary: raw.summary,
      ...(strayInSummary.length > 0 ? { summaryProblem: `mentions ${strayInSummary.join(', ')}, which appears nowhere in the evidence` } : {}),
      claims,
      suggestions: raw.suggestions.filter((s): s is string => typeof s === 'string'),
    },
  };
}

/**
 * Numbers in `text` that `evidence` does not contain — allowing for the same
 * value written another way (1.2s and 1200ms, 0.95 and 95%) and for rounding.
 * Numbers inside identifiers (api-1, n3, t16) are names, not measurements.
 */
export function unsupportedNumbers(text: string, evidence: string): string[] {
  const available = numbersIn(evidence).map((n) => n.value);
  const stray: string[] = [];
  for (const { raw, value } of numbersIn(text)) {
    const matches = available.some((m) => [value, value * 1000, value / 1000, value * 100, value / 100].some((v) => close(v, m)));
    if (!matches && !stray.includes(raw)) stray.push(raw);
  }
  return stray;
}

function numbersIn(text: string): { raw: string; value: number }[] {
  const found: { raw: string; value: number }[] = [];
  for (const match of text.matchAll(/(?<![\w.\-#])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g)) {
    const raw = `${match[1]}${match[2] ?? ''}`;
    found.push({ raw, value: Number(raw.replace(/,/g, '')) });
  }
  return found;
}

function close(a: number, b: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.02);
}

// --- experiments ------------------------------------------------------------

export interface CheckedExperiment {
  readonly experiment: Experiment;
  readonly hypothesis: string;
  /** The variant, when it validated. */
  readonly variant?: SimulationSpec;
  readonly issues: readonly SpecIssue[];
}

export function checkExperiment(raw: unknown, baseline: SimulationSpec): Checked<CheckedExperiment> {
  if (!isObject(raw) || typeof raw.name !== 'string' || !Array.isArray(raw.changes)) {
    return { ok: false, error: 'The proposal did not have the expected shape.' };
  }
  const issues: SpecIssue[] = [];
  const changes: ExperimentChange[] = [];
  raw.changes.forEach((entry, i) => {
    const path = `changes[${i}]`;
    const change = toChange(entry, path, issues);
    if (change) changes.push(change);
  });
  const experiment: Experiment = {
    name: raw.name.slice(0, 80) || 'Suggested experiment',
    ...(typeof raw.question === 'string' ? { question: raw.question } : {}),
    changes,
  };
  const hypothesis = typeof raw.hypothesis === 'string' ? raw.hypothesis : '';
  if (issues.length > 0 || changes.length === 0) {
    if (changes.length === 0 && issues.length === 0) issues.push({ path: 'changes', message: 'proposes no changes' });
    return { ok: true, value: { experiment, hypothesis, issues } };
  }
  const result = applyExperiment(baseline, experiment);
  return {
    ok: true,
    value: result.ok ? { experiment, hypothesis, variant: result.variant, issues: [] } : { experiment, hypothesis, issues: result.issues },
  };
}

function toChange(entry: unknown, path: string, issues: SpecIssue[]): ExperimentChange | undefined {
  if (!isObject(entry)) {
    issues.push({ path, message: 'must be an object' });
    return undefined;
  }
  const str = (key: string) => (typeof entry[key] === 'string' ? (entry[key] as string) : undefined);
  const num = (key: string) => (typeof entry[key] === 'number' ? (entry[key] as number) : undefined);
  const json = (key: string): { ok: true; value: unknown } | { ok: false } => {
    const text = str(key);
    if (text === undefined) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      issues.push({ path: `${path}.${key}`, message: 'is not valid JSON' });
      return { ok: false };
    }
  };
  const need = <T>(value: T | undefined, key: string): value is T => {
    if (value === undefined) issues.push({ path: `${path}.${key}`, message: 'is required for this kind of change' });
    return value !== undefined;
  };

  switch (entry.kind) {
    case 'scale_traffic': {
      const factor = num('factor');
      return need(factor, 'factor') ? { kind: 'scale_traffic', factor } : undefined;
    }
    case 'set_node': {
      const nodeId = str('nodeId');
      const field = str('field');
      const value = json('valueJson');
      if (!need(nodeId, 'nodeId') || !need(field, 'field') || !value.ok) {
        if (!value.ok && str('valueJson') === undefined) need(undefined, 'valueJson');
        return undefined;
      }
      return { kind: 'set_node', nodeId, field, value: value.value };
    }
    case 'set_link': {
      const linkId = str('linkId');
      const field = str('field');
      const value = json('valueJson');
      if (!need(linkId, 'linkId') || !need(field, 'field') || !value.ok) {
        if (!value.ok && str('valueJson') === undefined) need(undefined, 'valueJson');
        return undefined;
      }
      return { kind: 'set_link', linkId, field, value: value.value };
    }
    case 'set_all_links': {
      const field = str('field');
      const value = json('valueJson');
      if (!need(field, 'field') || !value.ok) {
        if (!value.ok && str('valueJson') === undefined) need(undefined, 'valueJson');
        return undefined;
      }
      return { kind: 'set_all_links', field, value: value.value };
    }
    case 'add_fault': {
      const fault = json('faultJson');
      if (!fault.ok) {
        if (str('faultJson') === undefined) need(undefined, 'faultJson');
        return undefined;
      }
      return { kind: 'add_fault', fault: fault.value as never };
    }
    case 'remove_faults':
      return { kind: 'remove_faults' };
    case 'set_seed': {
      const seed = str('seed');
      return need(seed, 'seed') ? { kind: 'set_seed', seed } : undefined;
    }
    case 'set_duration': {
      const durationMs = num('durationMs');
      return need(durationMs, 'durationMs') ? { kind: 'set_duration', durationMs } : undefined;
    }
    default:
      issues.push({ path: `${path}.kind`, message: `unknown change "${String(entry.kind)}"` });
      return undefined;
  }
}

// --- scenarios ------------------------------------------------------------------

export interface CheckedScenario {
  readonly summary: string;
  readonly spec?: SimulationSpec;
  readonly issues: readonly SpecIssue[];
}

/** Parses and validates a generated scenario exactly as an imported file would be. */
export function checkScenario(raw: unknown): Checked<CheckedScenario> {
  if (!isObject(raw) || typeof raw.specJson !== 'string') return { ok: false, error: 'The answer did not include a scenario.' };
  const summary = typeof raw.summary === 'string' ? raw.summary : '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.specJson);
  } catch {
    return { ok: true, value: { summary, issues: [{ path: 'specJson', message: 'is not valid JSON' }] } };
  }
  const validation = validateSimulationSpec(parsed);
  return validation.valid
    ? { ok: true, value: { summary, spec: parsed as SimulationSpec, issues: [] } }
    : { ok: true, value: { summary, issues: validation.errors } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { SCENARIO_ITEM };
