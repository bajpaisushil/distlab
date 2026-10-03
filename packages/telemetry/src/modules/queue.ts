import type { TelemetryModule } from './types.js';

export interface QueueTelemetry {}

export const queueTelemetry: TelemetryModule<QueueTelemetry> = {
  name: 'queue',
  levels: {},
  describe: () => undefined,
  record: () => {},
  snapshot: () => ({}),
};
