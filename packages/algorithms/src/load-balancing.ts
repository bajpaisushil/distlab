/**
 * Load-balancing strategies as pure functions.
 *
 * Each takes the candidates a node could send to right now, the node's own
 * bookkeeping, and — where chance is involved — an explicit random stream.
 * Nothing here knows about events or time passing; the engine module feeds
 * state in and stores what comes out, which is what makes every choice
 * reproducible and testable in isolation.
 */

export interface RandomSource {
  float(): number;
  int(minInclusive: number, maxExclusive: number): number;
}

/** Orders ids the way people read them: api-2 before api-10. */
export type IdOrder = (a: string, b: string) => number;

/**
 * The next id after `last` in sorted order, wrapping. Continuing after the
 * previous *id* rather than a numeric cursor keeps rotation fair when the
 * candidate set changes as nodes fail and recover.
 */
export function nextInRotation(sortedIds: readonly string[], last: string | undefined, order: IdOrder): string | undefined {
  if (sortedIds.length === 0) return undefined;
  if (last === undefined) return sortedIds[0];
  for (const id of sortedIds) if (order(id, last) > 0) return id;
  return sortedIds[0];
}

export interface WeightedCandidate {
  readonly id: string;
  readonly weight: number;
}

/**
 * nginx's smooth weighted round robin. Every round each candidate's current
 * weight grows by its weight; the highest is chosen and pays back the total.
 * Over a full cycle each gets exactly its share, interleaved rather than in
 * runs — 5:1:1 yields a a b a c a a, not a a a a a b c.
 */
export function smoothWeighted(
  candidates: readonly WeightedCandidate[],
  current: ReadonlyMap<string, number>,
): { chosen: string; next: Map<string, number>; total: number; compared: Map<string, number> } | undefined {
  if (candidates.length === 0) return undefined;
  const next = new Map(current);
  let total = 0;
  let best: string | undefined;
  let bestWeight = Number.NEGATIVE_INFINITY;
  const compared = new Map<string, number>();
  for (const candidate of candidates) {
    const value = (next.get(candidate.id) ?? 0) + candidate.weight;
    next.set(candidate.id, value);
    compared.set(candidate.id, value);
    total += candidate.weight;
    // Strictly greater: ties go to the earlier candidate in sorted order.
    if (value > bestWeight) {
      bestWeight = value;
      best = candidate.id;
    }
  }
  next.set(best!, (next.get(best!) ?? 0) - total);
  return { chosen: best!, next, total, compared };
}

/**
 * Fewest requests in flight. Ties continue the rotation instead of always
 * favouring the first candidate — otherwise an idle cluster would send
 * everything to whichever node sorts first.
 */
export function leastOutstanding(
  sortedIds: readonly string[],
  outstanding: ReadonlyMap<string, number>,
  last: string | undefined,
  order: IdOrder,
): { chosen: string; tied: string[] } | undefined {
  if (sortedIds.length === 0) return undefined;
  let fewest = Number.POSITIVE_INFINITY;
  for (const id of sortedIds) fewest = Math.min(fewest, outstanding.get(id) ?? 0);
  const tied = sortedIds.filter((id) => (outstanding.get(id) ?? 0) === fewest);
  const chosen = tied.length === 1 ? tied[0]! : nextInRotation(tied, last, order)!;
  return { chosen, tied };
}

export function uniform(ids: readonly string[], rng: RandomSource): string | undefined {
  if (ids.length === 0) return undefined;
  return ids[rng.int(0, ids.length)];
}

export interface LatencyCandidate {
  readonly id: string;
  readonly outstanding: number;
  /** Fresh EWMA estimate in ms, or undefined when untried or expired. */
  readonly estimate: number | undefined;
}

/**
 * Power of two choices over estimated cost. Picking the best of two random
 * candidates — rather than the global best — avoids the herd effect where
 * every balancer piles onto the same "fastest" backend at once, while still
 * steering clearly away from slow ones. Cost is latency × (in flight + 1),
 * so a fast backend that is already busy loses to an idle one.
 */
export function powerOfTwoChoices(
  candidates: readonly LatencyCandidate[],
  rng: RandomSource,
  prior: number,
): { chosen: string; sampled: { id: string; cost: number }[] } | undefined {
  if (candidates.length === 0) return undefined;
  const cost = (c: LatencyCandidate) => (c.estimate ?? prior) * (c.outstanding + 1);
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return { chosen: only.id, sampled: [{ id: only.id, cost: cost(only) }] };
  }
  const first = rng.int(0, candidates.length);
  let second = rng.int(0, candidates.length - 1);
  if (second >= first) second += 1;
  const a = candidates[first]!;
  const b = candidates[second]!;
  const sampled = [
    { id: a.id, cost: cost(a) },
    { id: b.id, cost: cost(b) },
  ];
  return { chosen: sampled[1]!.cost < sampled[0]!.cost ? b.id : a.id, sampled };
}

/** Exponentially weighted moving average. */
export function ewma(previous: number | undefined, sample: number, alpha: number): number {
  return previous === undefined ? sample : alpha * sample + (1 - alpha) * previous;
}

/** 32-bit MurmurHash3 (x86_32). Stable across platforms, so ring placement is reproducible. */
export function murmur3(text: string, seed = 0): number {
  let h = seed >>> 0;
  const length = text.length;
  let i = 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  while (i + 4 <= length) {
    let k =
      (text.charCodeAt(i) & 0xff) |
      ((text.charCodeAt(i + 1) & 0xff) << 8) |
      ((text.charCodeAt(i + 2) & 0xff) << 16) |
      ((text.charCodeAt(i + 3) & 0xff) << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    i += 4;
  }
  const tail = length & 3;
  if (tail > 0) {
    let k = 0;
    if (tail >= 3) k ^= (text.charCodeAt(i + 2) & 0xff) << 16;
    if (tail >= 2) k ^= (text.charCodeAt(i + 1) & 0xff) << 8;
    k ^= text.charCodeAt(i) & 0xff;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }
  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export interface RingPoint {
  readonly hash: number;
  readonly owner: string;
  readonly replica: number;
}

/** A consistent-hash ring with `virtualNodes` points per target, sorted by hash. */
export function buildRing(ids: readonly string[], virtualNodes: number): RingPoint[] {
  const points: RingPoint[] = [];
  for (const owner of ids) {
    for (let replica = 0; replica < virtualNodes; replica++) {
      points.push({ hash: murmur3(`${owner}#${replica}`), owner, replica });
    }
  }
  // Ties on hash (vanishingly rare) break by owner so the order is total.
  return points.sort((a, b) => a.hash - b.hash || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.replica - b.replica));
}

/** The first ring point at or after the key's hash, wrapping to the start. */
export function ringLookup(ring: readonly RingPoint[], keyHash: number): RingPoint | undefined {
  if (ring.length === 0) return undefined;
  let low = 0;
  let high = ring.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ring[mid]!.hash < keyHash) low = mid + 1;
    else high = mid;
  }
  return ring[low === ring.length ? 0 : low];
}
