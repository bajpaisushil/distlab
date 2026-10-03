import type { TelemetryModule } from './types.js';

export interface LockTelemetry {}

export const locksTelemetry: TelemetryModule<LockTelemetry> = {
  name: 'locks',
  levels: {},
  describe: () => undefined,
  record: () => {},
  snapshot: () => ({}),
};
