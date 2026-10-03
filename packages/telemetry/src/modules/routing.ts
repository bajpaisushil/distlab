import type { TelemetryModule } from './types.js';

export interface RoutingTelemetry {}

export const routingTelemetry: TelemetryModule<RoutingTelemetry> = {
  name: 'routing',
  levels: {},
  describe: () => undefined,
  record: () => {},
  snapshot: () => ({}),
};
