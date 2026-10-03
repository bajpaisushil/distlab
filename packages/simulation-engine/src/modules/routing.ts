import type { RequestBody, SimNode } from '@distlab/shared';
import type { ModuleServices, RoutingPolicy } from './types.js';

/**
 * Load balancing.
 *
 * Today: every node picks the first healthy candidate in topology order.
 */
export function createRoutingPolicy(_services: ModuleServices): RoutingPolicy {
  return {
    strategyName: () => 'first_available',
    select: (_node: SimNode, _body: RequestBody, candidates: readonly SimNode[]) => candidates[0],
    onDispatch: () => {},
    onOutcome: () => {},
    captureState: () => ({}),
    restoreState: () => {},
  };
}
