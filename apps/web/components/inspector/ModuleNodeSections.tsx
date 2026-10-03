'use client';

import type { NodeSpec } from '@distlab/shared';
import { RoutingSection } from '@/components/modules/RoutingSection';
import { ReliabilitySection } from '@/components/modules/ReliabilitySection';
import { DataSection } from '@/components/modules/DataSection';
import { QueueSection } from '@/components/modules/QueueSection';

/**
 * Subsystem settings for a node. Each section decides for itself whether it
 * applies to this node, so adding a subsystem never touches the others.
 */
export function ModuleNodeSections({ node }: { node: NodeSpec }) {
  return (
    <>
      <RoutingSection node={node} />
      <DataSection node={node} />
      <QueueSection node={node} />
      <ReliabilitySection node={node} />
    </>
  );
}
