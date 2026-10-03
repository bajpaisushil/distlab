/**
 * Queue delivery bookkeeping.
 *
 * Which consumer gets the next delivery, and what happens to an item whose
 * delivery failed. Pure, so the at-least-once rules can be tested without a
 * network in the way.
 */

export interface ConsumerSlot {
  readonly id: string;
  readonly inFlight: number;
  readonly prefetch: number;
  readonly available: boolean;
}

/**
 * The next consumer with room, rotating after the previous pick so that
 * deliveries spread across workers rather than filling the first one.
 */
export function nextConsumer(consumers: readonly ConsumerSlot[], last: string | undefined): string | undefined {
  const open = consumers.filter((c) => c.available && c.inFlight < c.prefetch);
  if (open.length === 0) return undefined;
  if (last === undefined) return open[0]!.id;
  const after = open.find((c) => c.id > last);
  return (after ?? open[0]!).id;
}

/** After a failed delivery: try again, or give up and dead-letter. */
export function afterFailure(attemptsMade: number, maxDeliveries: number): 'redeliver' | 'dead_letter' {
  return attemptsMade >= maxDeliveries ? 'dead_letter' : 'redeliver';
}
