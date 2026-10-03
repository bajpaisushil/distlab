import { isWriteOperation, type LatencySpec, type RequestBody, type SimNode } from '@distlab/shared';
import type { DataPlane, ModuleServices, ServeDecision, ServeRequest } from './types.js';

const STORAGE_TYPES = new Set(['database', 'replica']);
const TERMINAL_TYPES = new Set(['database', 'replica', 'cache']);

/**
 * Storage on the request path.
 *
 * Today: databases, replicas and caches serve every request they receive and
 * record a read or write; nothing is versioned or replicated yet.
 */
export function createDataPlane(services: ModuleServices): DataPlane {
  return {
    name: 'data',
    messageKinds: [],
    servesNodeTypes: [],
    attach: () => {},
    onMessage: () => {},
    onTimer: () => {},
    onNodeFailed: () => {},
    onNodeRecovered: () => {},
    captureState: () => ({}),
    restoreState: () => {},

    serviceLatency(node: SimNode, body: RequestBody): LatencySpec {
      if (STORAGE_TYPES.has(node.type)) {
        const specific = isWriteOperation(body.operation) ? node.config.writeLatency : node.config.readLatency;
        if (specific !== undefined) return specific;
      }
      return node.config.processing;
    },

    serve({ node, body, message, serviceTime, causedBy }: ServeRequest): ServeDecision {
      if (!TERMINAL_TYPES.has(node.type)) return { kind: 'forward' };
      if (STORAGE_TYPES.has(node.type)) {
        const payload = { nodeId: node.id, requestId: message.requestId, latency: serviceTime };
        services.emit(isWriteOperation(body.operation) ? 'DB_WRITE' : 'DB_READ', payload, {
          nodeId: node.id,
          traceId: message.traceId,
          causedBy,
        });
      }
      return { kind: 'respond', status: 'ok' };
    },

    filterCandidates: (_node, _body, candidates) => candidates,
    onDownstreamResponse: () => undefined,
  };
}
