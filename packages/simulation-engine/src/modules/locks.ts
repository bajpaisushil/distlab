import type { ModuleServices, SimModule } from './types.js';

/** Distributed locks with leases and fencing tokens. */
export function createLocksModule(_services: ModuleServices): SimModule {
  return {
    name: 'locks',
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
