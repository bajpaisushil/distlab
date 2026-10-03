import { meanLatency, type NodeId, type ResolvedSpec } from '@distlab/shared';
import { configured, derived, type Explanation, type Fact } from './types.js';
import { list, ms, percent } from './text.js';

const STORAGE = new Set(['database', 'replica', 'cache']);

/**
 * What an architecture will do before it runs: the paths requests take, the
 * fastest any request could complete, which single nodes would cut traffic
 * off, and where capacity is thin. Everything here comes from configuration
 * and is labelled as such — run the scenario to see what actually happens.
 */
export function explainArchitecture(spec: ResolvedSpec): Explanation {
  const label = (id: NodeId) => spec.nodes.find((n) => n.id === id)?.label ?? id;
  const facts: Fact[] = [];
  const interpretation: string[] = [];
  const suggestions: string[] = [];

  const adjacency = new Map<NodeId, NodeId[]>();
  for (const link of spec.links) {
    if (!link.enabled) continue;
    adjacency.set(link.from, [...(adjacency.get(link.from) ?? []), link.to]);
  }
  const linkLatency = new Map(spec.links.map((l) => [`${l.from}|${l.to}`, meanLatency(l.latency)]));
  const clients = spec.nodes.filter((n) => n.type === 'client');

  // Every simple path from each client to where requests end.
  const paths: NodeId[][] = [];
  const walk = (path: NodeId[]) => {
    const here = path[path.length - 1]!;
    const next = (adjacency.get(here) ?? []).filter((n) => !path.includes(n));
    const node = spec.nodes.find((n) => n.id === here);
    if (next.length === 0 || (node && STORAGE.has(node.type) && node.type !== 'cache')) {
      if (path.length > 1) paths.push(path);
      return;
    }
    if (paths.length > 200) return;
    for (const n of next) walk([...path, n]);
  };
  for (const client of clients) walk([client.id]);

  if (clients.length === 0) facts.push(configured('There is no client, so nothing generates traffic.'));
  for (const path of paths.slice(0, 8)) {
    let floor = 0;
    for (let i = 1; i < path.length; i++) {
      floor += 2 * (linkLatency.get(`${path[i - 1]}|${path[i]}`) ?? 0);
      const node = spec.nodes.find((n) => n.id === path[i]);
      if (node) floor += meanLatency(node.config.processing);
    }
    facts.push(derived(`${path.map(label).join(' → ')}: about ${ms(floor)} at best (mean link latency both ways plus mean processing, with no queueing).`));
  }
  if (paths.length > 8) facts.push(derived(`…and ${paths.length - 8} more paths.`));

  // Single points of failure: nodes whose loss cuts every client off from every end of the line.
  const ends = new Set(paths.map((p) => p[p.length - 1]!));
  const reachable = (removed: NodeId) => {
    for (const client of clients) {
      const seen = new Set<NodeId>([client.id]);
      const queue = [client.id];
      while (queue.length) {
        const here = queue.shift()!;
        if (ends.has(here) && here !== removed) return true;
        for (const next of adjacency.get(here) ?? []) {
          if (next === removed || seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  };
  const spofs = spec.nodes.filter((n) => n.type !== 'client' && ends.size > 0 && !reachable(n.id));
  if (spofs.length > 0) {
    facts.push(derived(`Single points of failure — losing any one stops all traffic: ${list(spofs.map((n) => label(n.id)))}.`));
    suggestions.push(`Crash ${label(spofs[0]!.id)} mid-run to watch every request fail, then add a second instance and compare.`);
  } else if (ends.size > 0) {
    facts.push(derived('No single node failure cuts every client off.'));
  }

  // Capacity estimate under an even split, labelled as an estimate.
  const offered = new Map<NodeId, number>();
  for (const workload of spec.workloads) {
    const rate =
      workload.arrival.kind === 'constant' || workload.arrival.kind === 'poisson'
        ? workload.arrival.ratePerSec
        : workload.arrival.kind === 'burst'
          ? (workload.arrival.count * 1000) / workload.arrival.everyMs
          : 0;
    const clientPaths = paths.filter((p) => p[0] === workload.clientId);
    if (clientPaths.length === 0) continue;
    // Spread evenly over the alternatives at each fork: count how many paths pass through each node.
    const share = new Map<NodeId, number>();
    for (const path of clientPaths) for (const id of path.slice(1)) share.set(id, (share.get(id) ?? 0) + 1 / clientPaths.length);
    for (const [id, fraction] of share) offered.set(id, (offered.get(id) ?? 0) + rate * fraction);
  }
  const hot: string[] = [];
  for (const [id, rate] of offered) {
    const node = spec.nodes.find((n) => n.id === id);
    if (!node) continue;
    const service = meanLatency(node.config.processing);
    if (service <= 0) continue;
    const capacity = (node.config.concurrency * 1000) / service;
    const load = rate / capacity;
    if (load >= 0.7) hot.push(`${label(id)} at ~${percent(load)} of ${Math.round(capacity)} req/s`);
  }
  if (hot.length > 0) {
    facts.push(derived(`Estimated from configuration, assuming an even split: likely bottlenecks are ${list(hot)}.`));
    interpretation.push('Utilisation above ~70% is where queueing delay starts to climb steeply; above 100% the backlog grows without bound.');
    suggestions.push('Run it and compare the measured utilisation with this estimate — waiting on downstream calls also holds worker slots, which the estimate ignores.');
  } else if (offered.size > 0) {
    facts.push(derived('Estimated from configuration, every node has comfortable headroom for the configured traffic.'));
  }

  for (const workload of spec.workloads) {
    facts.push(configured(`Workload ${workload.id}: clients give up after ${ms(workload.deadlineMs)}.`));
  }

  const replicas = spec.nodes.filter((n) => n.type === 'replica');
  if (replicas.length > 0) {
    interpretation.push('Replicas can serve reads, which may return data older than the primary holds.');
  }

  return {
    title: 'Architecture review',
    summary: `${paths.length === 0 ? 'No complete request path exists yet.' : `${paths.length} request ${paths.length === 1 ? 'path' : 'paths'}.`} ${
      spofs.length > 0 ? `${spofs.length} single ${spofs.length === 1 ? 'point' : 'points'} of failure.` : 'No single point of failure.'
    } ${hot.length > 0 ? `Likely bottlenecks: ${list(hot.map((h) => h.split(' at ')[0]!))}.` : 'No bottleneck predicted from configuration.'} These are predictions from configuration; run the scenario to measure.`,
    facts,
    interpretation,
    suggestions,
  };
}
