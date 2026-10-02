import type { LinkSpec, NodeSpec, SimulationSpec, WorkloadSpec } from '@distlab/shared';
import { SPEC_VERSION } from '@distlab/shared';

export interface ScenarioOptions {
  seed?: string;
  durationMs?: number;
  nodes?: NodeSpec[];
  links?: LinkSpec[];
  workloads?: WorkloadSpec[];
}

/**
 * Client -> load balancer -> API -> database, with every latency fixed so that
 * expected timings can be written down by hand rather than asserted loosely.
 */
export function chainScenario(options: ScenarioOptions = {}): SimulationSpec {
  return {
    version: SPEC_VERSION,
    id: 'test-chain',
    name: 'Test chain',
    seed: options.seed ?? 'test',
    durationMs: options.durationMs ?? 10_000,
    nodes: options.nodes ?? [
      { id: 'client', type: 'client' },
      { id: 'lb', type: 'load_balancer', config: { processing: 1 } },
      { id: 'api', type: 'api', config: { processing: 15 } },
      { id: 'db', type: 'database', config: { readLatency: 10, writeLatency: 30 } },
    ],
    links: options.links ?? [
      { from: 'client', to: 'lb', latency: 10 },
      { from: 'lb', to: 'api', latency: 10 },
      { from: 'api', to: 'db', latency: 10 },
    ],
    workloads: options.workloads ?? [
      { id: 'w1', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'once', count: 1 } },
    ],
  };
}

export function constantLoad(ratePerSec: number, overrides: Partial<WorkloadSpec> = {}): WorkloadSpec {
  return {
    id: 'load',
    clientId: 'client',
    operation: 'HTTP_GET',
    arrival: { kind: 'constant', ratePerSec },
    ...overrides,
  };
}
