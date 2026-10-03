/**
 * Replication ordering.
 *
 * A primary numbers every write with a log sequence number. A replica that
 * applies records strictly in that order — buffering any that arrive early —
 * converges to exactly the primary's state no matter how the network reorders
 * them. One that applies records in arrival order does not.
 */

export interface ReplicationRecord {
  readonly lsn: number;
  readonly key: string;
  readonly version: number;
  readonly writtenAt: number;
}

export interface OrderedApply<R extends ReplicationRecord> {
  /** Records now safe to apply, in LSN order. */
  readonly apply: readonly R[];
  readonly appliedThrough: number;
  /** Records still waiting for an earlier one. */
  readonly buffer: ReadonlyMap<number, R>;
  /** The record had already been applied (a retransmission or duplicate). */
  readonly duplicate: boolean;
}

export function acceptOrdered<R extends ReplicationRecord>(
  appliedThrough: number,
  buffer: ReadonlyMap<number, R>,
  record: R,
): OrderedApply<R> {
  if (record.lsn <= appliedThrough || buffer.has(record.lsn)) {
    return { apply: [], appliedThrough, buffer, duplicate: true };
  }
  const next = new Map(buffer);
  next.set(record.lsn, record);
  const apply: R[] = [];
  let through = appliedThrough;
  while (next.has(through + 1)) {
    apply.push(next.get(through + 1)!);
    next.delete(through + 1);
    through += 1;
  }
  return { apply, appliedThrough: through, buffer: next, duplicate: false };
}

/** Records a primary must still send a replica that has applied everything up to `ackedThrough`. */
export function unacknowledged<R extends ReplicationRecord>(log: readonly R[], ackedThrough: number, limit: number): R[] {
  const out: R[] = [];
  for (const record of log) {
    if (record.lsn > ackedThrough) out.push(record);
    if (out.length >= limit) break;
  }
  return out;
}
