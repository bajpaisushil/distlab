/** Message queue, consumer and dead-letter contracts. */
import type { IssueReporter, SpecValidationContext } from '../validation.js';

export interface QueueNodeConfig {}

export type QueueMessageKind = never;
export type QueueMessagePayload = never;

export interface QueueEventPayloads {}

export function validateQueueConfig(
  _config: QueueNodeConfig,
  _path: string,
  _push: IssueReporter,
  _context: SpecValidationContext,
): void {}
