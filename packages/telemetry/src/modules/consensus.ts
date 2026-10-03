import type { TelemetryModule } from './types.js';

export interface ConsensusTelemetry {}

export const consensusTelemetry: TelemetryModule<ConsensusTelemetry> = {
  name: 'consensus',
  levels: {},
  describe: () => undefined,
  record: () => {},
  snapshot: () => ({}),
};
