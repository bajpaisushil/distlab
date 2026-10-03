/**
 * Raft's rules, as pure functions.
 *
 * Educational: these follow the Raft paper's election and log-replication
 * rules faithfully, but this is not a production consensus implementation.
 */

export interface Entry {
  readonly term: number;
  readonly index: number;
  readonly command: string;
}

/** Votes needed in a cluster of `size`. */
export function quorum(size: number): number {
  return Math.floor(size / 2) + 1;
}

export function lastIndex(log: readonly Entry[]): number {
  return log.length;
}

export function lastTerm(log: readonly Entry[]): number {
  return log[log.length - 1]?.term ?? 0;
}

export function termAt(log: readonly Entry[], index: number): number {
  return index === 0 ? 0 : log[index - 1]?.term ?? -1;
}

/**
 * The election restriction: grant a vote only to a candidate whose log is at
 * least as up to date as ours — a later last term, or the same last term and
 * at least as long. This is what guarantees a new leader already holds every
 * committed entry.
 */
export function candidateIsUpToDate(candidateLastTerm: number, candidateLastIndex: number, log: readonly Entry[]): boolean {
  const mine = lastTerm(log);
  return candidateLastTerm > mine || (candidateLastTerm === mine && candidateLastIndex >= lastIndex(log));
}

export type AppendResult =
  | { readonly ok: true; readonly log: Entry[]; readonly matchIndex: number; readonly truncatedFrom?: number }
  | { readonly ok: false; readonly hint: number };

/**
 * The log consistency check. A follower accepts entries only if its log holds
 * an entry at `prevLogIndex` with `prevLogTerm`; any existing entry that
 * conflicts with a new one (same index, different term) is deleted along with
 * everything after it. On rejection, `hint` tells the leader where to retry.
 */
export function appendEntries(
  log: readonly Entry[],
  prevLogIndex: number,
  prevLogTerm: number,
  entries: readonly Entry[],
): AppendResult {
  if (prevLogIndex > log.length) return { ok: false, hint: log.length };
  if (termAt(log, prevLogIndex) !== prevLogTerm) return { ok: false, hint: Math.max(0, prevLogIndex - 1) };
  const next = log.slice();
  let truncatedFrom: number | undefined;
  for (const entry of entries) {
    const existing = next[entry.index - 1];
    if (existing && existing.term !== entry.term) {
      truncatedFrom = entry.index;
      next.length = entry.index - 1;
    }
    if (!next[entry.index - 1]) next.push(entry);
  }
  return { ok: true, log: next, matchIndex: prevLogIndex + entries.length, ...(truncatedFrom !== undefined ? { truncatedFrom } : {}) };
}

/**
 * The highest index a leader may now consider committed: replicated on a
 * majority (counting itself) and — crucially — from the leader's current
 * term. Entries from earlier terms are committed only indirectly, by a
 * current-term entry after them; committing them directly is unsafe (Raft
 * paper §5.4.2, Figure 8).
 */
export function commitIndexFor(
  log: readonly Entry[],
  currentTerm: number,
  commitIndex: number,
  followerMatchIndexes: readonly number[],
  clusterSize: number,
): number {
  for (let n = lastIndex(log); n > commitIndex; n--) {
    if (termAt(log, n) !== currentTerm) continue;
    const replicas = 1 + followerMatchIndexes.filter((m) => m >= n).length;
    if (replicas >= quorum(clusterSize)) return n;
  }
  return commitIndex;
}
