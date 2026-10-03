/** Storage, replication and caching contracts. */
import type { NodeId, RequestId } from '../ids.js';
import type { IssueReporter, SpecValidationContext } from '../validation.js';

export interface DataNodeConfig {}

/** Message kinds the data layer sends between storage nodes. */
export type DataMessageKind = never;
export type DataMessagePayload = never;

export interface DataEventPayloads {
  DB_READ: { nodeId: NodeId; requestId: RequestId; latency: number };
  DB_WRITE: { nodeId: NodeId; requestId: RequestId; latency: number };
}

export function validateDataConfig(
  _config: DataNodeConfig,
  _path: string,
  _push: IssueReporter,
  _context: SpecValidationContext,
): void {}
