/** Raft-like leader election and log replication contracts. */
import type { IssueReporter, SpecValidationContext } from '../validation.js';

export interface ConsensusNodeConfig {}

export type ConsensusMessageKind = never;
export type ConsensusMessagePayload = never;

export interface ConsensusEventPayloads {}

export function validateConsensusConfig(
  _config: ConsensusNodeConfig,
  _path: string,
  _push: IssueReporter,
  _context: SpecValidationContext,
): void {}
