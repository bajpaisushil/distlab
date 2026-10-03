'use client';

import type { NodeSpec } from '@distlab/shared';

/**
 * Subsystem settings for a node — routing strategy, replication, retries and
 * timeouts, queues, consensus, locks. Each subsystem contributes the section
 * that applies to this node type.
 */
export function ModuleNodeSections(_props: { node: NodeSpec }) {
  return null;
}
