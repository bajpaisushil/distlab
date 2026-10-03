import type { TelemetryModule } from './types.js';

export interface ReliabilityTelemetry {}

export const reliabilityTelemetry: TelemetryModule<ReliabilityTelemetry> = {
  name: 'reliability',
  levels: {},
  describe: () => undefined,
  record: () => {},
  snapshot: () => ({}),
};
