/** Distributed lock, lease and fencing contracts. */
import type { IssueReporter, SpecValidationContext } from '../validation.js';

export interface LockNodeConfig {}

export type LockMessageKind = never;
export type LockMessagePayload = never;

export interface LockEventPayloads {}

export function validateLockConfig(
  _config: LockNodeConfig,
  _path: string,
  _push: IssueReporter,
  _context: SpecValidationContext,
): void {}
