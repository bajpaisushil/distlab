'use client';

import type { SimulationSpec } from '@distlab/shared';
import { EngineClient } from './client';
import type { RunSummary } from './protocol';

let batch: EngineClient | undefined;

/**
 * Runs whole scenarios to completion on a second worker, so comparisons and
 * what-if experiments never stall the run being watched in the lab.
 */
export function runInBackground(spec: SimulationSpec): Promise<RunSummary> {
  batch ??= new EngineClient({ onFrame: () => {}, onInvalid: () => {}, onError: () => {} });
  return batch.query({ kind: 'run', spec });
}
