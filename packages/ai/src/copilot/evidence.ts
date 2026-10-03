import { describeFault, meanLatency, type SimulationSpec } from '@distlab/shared';
import type { TelemetrySnapshot } from '@distlab/telemetry';
import type { Explanation, FactKind } from '../types.js';
import { ms, percent } from '../text.js';

/**
 * Everything an AI model is allowed to know about a run, as numbered items it
 * must cite. Built locally and deterministically, shown to the user before
 * anything is sent, and the only basis on which the model's answer is checked.
 */
export interface EvidenceItem {
  /** `F1`… facts from the local explanation, `M1`… measured metrics, `SCENARIO` for the configuration. */
  readonly id: string;
  readonly kind: FactKind;
  readonly text: string;
  readonly eventIds: readonly string[];
}

export interface EvidencePack {
  readonly scenarioName: string;
  /** What the user is looking at: the local explanation's title and summary. */
  readonly focus: string;
  readonly items: readonly EvidenceItem[];
  readonly question: string;
}

export const SCENARIO_ITEM = 'SCENARIO';
const MAX_NODES = 60;
const MAX_FACTS = 40;

export function buildEvidence(input: {
  spec: SimulationSpec;
  snapshot: TelemetrySnapshot | undefined;
  explanation: Explanation | undefined;
  question: string;
}): EvidencePack {
  const { spec, snapshot, explanation } = input;
  const items: EvidenceItem[] = [{ id: SCENARIO_ITEM, kind: 'configured', text: describeScenario(spec), eventIds: [] }];
  (explanation?.facts ?? []).slice(0, MAX_FACTS).forEach((fact, i) => {
    items.push({ id: `F${i + 1}`, kind: fact.kind, text: fact.text, eventIds: [...fact.eventIds] });
  });
  if (snapshot) metricLines(snapshot).forEach((text, i) => items.push({ id: `M${i + 1}`, kind: 'measured', text, eventIds: [] }));
  return {
    scenarioName: spec.name,
    focus: explanation ? `${explanation.title}: ${explanation.summary}` : 'The scenario as a whole.',
    items,
    question: input.question.trim(),
  };
}

/** The exact text sent as the user's message. What the preview shows is what is sent. */
export function renderEvidence(pack: EvidencePack): string {
  const lines = [
    `Scenario: ${pack.scenarioName}`,
    `Focus: ${pack.focus}`,
    '',
    'Evidence (cite by id):',
    ...pack.items.map((item) => `[${item.id}] (${item.kind}) ${item.text}`),
  ];
  if (pack.question) lines.push('', `Question: ${pack.question}`);
  return lines.join('\n');
}

function describeScenario(spec: SimulationSpec): string {
  const nodes = spec.nodes.slice(0, MAX_NODES).map((n) => {
    const config = n.config ?? {};
    const parts: string[] = [];
    if (config.processing !== undefined) parts.push(`processing ~${round(meanLatency(config.processing))}ms`);
    if (config.concurrency !== undefined) parts.push(`concurrency ${config.concurrency}`);
    if (config.queueCapacity !== undefined) parts.push(`queue ${config.queueCapacity}`);
    for (const key of Object.keys(config).sort()) {
      if (['processing', 'concurrency', 'queueCapacity'].includes(key)) continue;
      parts.push(`${key} ${JSON.stringify((config as Record<string, unknown>)[key])}`);
    }
    return `${n.id} (${n.type}${n.label ? `, "${n.label}"` : ''})${parts.length > 0 ? `: ${parts.join('; ')}` : ''}`;
  });
  const links = spec.links.map((l) => {
    const extras = [
      l.lossRate ? `loss ${percent(l.lossRate)}` : '',
      l.duplicateRate ? `duplicates ${percent(l.duplicateRate)}` : '',
      l.reorderRate ? `reorders ${percent(l.reorderRate)}` : '',
      l.bidirectional === false ? 'one-way' : '',
    ].filter(Boolean);
    return `${l.from}->${l.to} ~${round(meanLatency(l.latency ?? 0))}ms${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`;
  });
  const workloads = spec.workloads.map((w) => {
    const rate = 'ratePerSec' in w.arrival ? `${w.arrival.ratePerSec}/s ${w.arrival.kind}` : JSON.stringify(w.arrival);
    return `${w.id}: ${w.clientId} sends ${w.operation} at ${rate}${w.deadlineMs ? `, deadline ${w.deadlineMs}ms` : ''}`;
  });
  const faults = (spec.faults ?? []).map((f) => describeFault(f));
  return [
    `duration ${spec.durationMs}ms, seed "${spec.seed}"`,
    `nodes: ${nodes.join(' | ')}${spec.nodes.length > MAX_NODES ? ` | …and ${spec.nodes.length - MAX_NODES} more` : ''}`,
    `links: ${links.join(', ') || 'none'}`,
    `workloads: ${workloads.join('; ') || 'none'}`,
    `faults: ${faults.join('; ') || 'none'}`,
  ].join('. ');
}

/** Headline measurements, only for what the scenario actually exercises. */
function metricLines(s: TelemetrySnapshot): string[] {
  const lines: string[] = [];
  const settled = s.requests.completed + s.requests.failed;
  if (s.requests.created > 0) {
    lines.push(`At ${ms(s.elapsedMs)}: ${s.requests.created} requests issued, ${s.requests.completed} completed, ${s.requests.failed} failed, ${s.requests.rejected} rejected.`);
    if (settled > 0) lines.push(`Success rate ${percent(s.requests.successRate)}; throughput ${round(s.requests.throughputPerSec)} completed/s.`);
    if (s.latency.count > 0) lines.push(`Latency p50 ${ms(s.latency.p50)}, p95 ${ms(s.latency.p95)}, p99 ${ms(s.latency.p99)}, max ${ms(s.latency.max)}.`);
    const reasons = Object.entries(s.failuresByReason);
    if (reasons.length > 0) lines.push(`Failures by reason: ${reasons.map(([r, n]) => `${r} ${n}`).join(', ')}.`);
    lines.push(`Timeouts: ${s.timeouts}.`);
  }
  lines.push(`Messages: ${s.messages.sent} sent, ${s.messages.dropped} dropped, ${s.messages.duplicated} duplicated.`);
  const drops = Object.entries(s.messages.dropsByReason);
  if (drops.length > 0) lines.push(`Drops by reason: ${drops.map(([r, n]) => `${r} ${n}`).join(', ')}.`);
  const busy = [...s.nodes].filter((n) => n.utilization > 0).sort((a, b) => b.utilization - a.utilization).slice(0, 6);
  if (busy.length > 0) lines.push(`Utilisation: ${busy.map((n) => `${n.id} ${percent(n.utilization)} (peak queue ${n.maxQueueDepth})`).join(', ')}.`);

  const m = s.modules;
  if (m.reliability.retries > 0) lines.push(`Retries: ${m.reliability.retries}; call timeouts ${m.reliability.callTimeouts}; fast fails ${m.reliability.fastFails}.`);
  for (const c of m.reliability.circuits) lines.push(`Circuit ${c.nodeId}->${c.target} is ${c.state}.`);
  if (m.data.replicas.length > 0 || m.data.reads + m.data.writes > 0) {
    lines.push(`Data: ${m.data.reads} reads, ${m.data.writes} writes, ${m.data.staleReads} stale reads, ${m.data.versionRegressions} version regressions, ${m.data.duplicateWritesApplied} duplicate writes applied.`);
  }
  for (const r of m.data.replicas) lines.push(`Replica ${r.replicaId}: max lag ${ms(r.maxLagMs)}, mean lag ${ms(r.meanLagMs)}, ${r.staleReads} of ${r.reads} reads stale.`);
  for (const c of m.data.caches) lines.push(`Cache ${c.nodeId}: hit ratio ${percent(c.hitRatio)} (${c.hits} hits, ${c.misses} misses).`);
  for (const q of m.queues.queues) {
    lines.push(`Queue ${q.queueId}: ${q.enqueued} enqueued, ${q.consumed} consumed, ${q.rejected} refused, ${q.redelivered} redelivered, ${q.deadLettered} dead-lettered, ${q.duplicates} processed twice.`);
  }
  for (const c of m.consensus.clusters) {
    lines.push(`Raft cluster ${c.clusterId}: leader ${c.leader ?? 'none'} in term ${c.term}; ${c.elections} elections (${c.failedElections} split or lost); ${ms(c.unavailableMs)} without a leader; ${c.commits} entries committed; at most ${c.maxBelievedLeaders} nodes believed they led at once.`);
  }
  for (const r of m.locks.resources) {
    lines.push(`Lock "${r.resource}": holder ${r.holder ?? 'none'} (token ${r.token}); ${r.acquisitions} acquisitions, ${r.expirations} leases expired, wait p95 ${ms(r.wait.p95)}; at most ${r.maxBelievedHolders} clients believed they held it at once; ${r.safetyViolations} safety violations; ${r.fencedRejections} stale writes refused by fencing.`);
  }
  for (const [node, frozen] of Object.entries(m.faults.frozenMs)) lines.push(`${node} spent ${ms(frozen)} frozen.`);
  return lines;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
