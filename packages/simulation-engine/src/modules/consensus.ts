import type { ModuleServices, SimModule } from './types.js';

/** Raft-like leader election and log replication. */
export function createConsensusModule(_services: ModuleServices): SimModule {
  return {
    name: 'consensus',
    messageKinds: [],
    servesNodeTypes: [],
    attach: () => {},
    onMessage: () => {},
    onTimer: () => {},
    onNodeFailed: () => {},
    onNodeRecovered: () => {},
    captureState: () => ({}),
    restoreState: () => {},
  };
}
