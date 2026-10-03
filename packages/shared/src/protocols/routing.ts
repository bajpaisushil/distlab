/** Load-balancing contracts: which downstream a forwarding node picks. */
import type { IssueReporter, SpecValidationContext } from '../validation.js';

export interface RoutingNodeConfig {}

export interface RoutingEventPayloads {}

export function validateRoutingConfig(
  _config: RoutingNodeConfig,
  _path: string,
  _push: IssueReporter,
  _context: SpecValidationContext,
): void {}
