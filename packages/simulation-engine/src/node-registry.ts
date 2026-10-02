import {
  createNodeRuntimeState,
  invariant,
  nodeUtilization,
  type NodeId,
  type NodeStatus,
  type NodeType,
  type ResolvedNodeSpec,
  type SimNode,
  type SimTime,
} from '@distlab/shared';

/** Owns every node's identity, configuration and mutable runtime state. */
export class NodeRegistry {
  private readonly nodes = new Map<NodeId, SimNode>();

  constructor(specs: readonly ResolvedNodeSpec[]) {
    for (const spec of specs) {
      this.nodes.set(spec.id, {
        id: spec.id,
        type: spec.type,
        label: spec.label,
        config: spec.config,
        metadata: spec.metadata,
        state: createNodeRuntimeState(spec.status),
      });
    }
  }

  get(id: NodeId): SimNode | undefined {
    return this.nodes.get(id);
  }

  require(id: NodeId): SimNode {
    const node = this.nodes.get(id);
    invariant(node !== undefined, `unknown node "${id}"`);
    return node;
  }

  all(): readonly SimNode[] {
    return [...this.nodes.values()];
  }

  byType(type: NodeType): SimNode[] {
    return this.all().filter((node) => node.type === type);
  }

  isUp(id: NodeId): boolean {
    return this.nodes.get(id)?.state.status !== 'failed';
  }

  setStatus(id: NodeId, status: NodeStatus, at: SimTime): void {
    const node = this.require(id);
    node.state.status = status;
    node.state.lastStatusChangeAt = at;
  }

  /** A point-in-time copy for the UI, with utilisation folded in. */
  snapshot(elapsed: SimTime): NodeSnapshot[] {
    return this.all().map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      status: node.state.status,
      inFlight: node.state.inFlight,
      queueDepth: node.state.queueDepth,
      processed: node.state.processed,
      failed: node.state.failed,
      rejected: node.state.rejected,
      utilization: nodeUtilization(node, elapsed),
    }));
  }
}

export interface NodeSnapshot {
  readonly id: NodeId;
  readonly type: NodeType;
  readonly label: string;
  readonly status: NodeStatus;
  readonly inFlight: number;
  readonly queueDepth: number;
  readonly processed: number;
  readonly failed: number;
  readonly rejected: number;
  readonly utilization: number;
}
