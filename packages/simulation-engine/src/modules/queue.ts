import type { ModuleServices, SimModule } from './types.js';

/** Message queues, consumers and dead-letter handling. */
export function createQueueModule(_services: ModuleServices): SimModule {
  return {
    name: 'queue',
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
