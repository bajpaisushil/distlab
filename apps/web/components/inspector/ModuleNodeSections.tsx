'use client';

import type { NodeSpec } from '@distlab/shared';
import { RoutingSection } from '@/components/modules/RoutingSection';

/**
 * Subsystem settings for a node. Each section decides for itself whether it
 * applies to this node, so adding a subsystem never touches the others.
 */
export function ModuleNodeSections({ node }: { node: NodeSpec }) {
  return (
    <>
      <RoutingSection node={node} />
    </>
  );
}
