import type { LinkConfig, LinkId, NodeId, PartitionSpec } from '@distlab/shared';

/** Links are immutable values (updates replace them), so a capture can share them. */
export interface TopologyState {
  readonly links: readonly LinkConfig[];
  readonly partitions: readonly PartitionSpec[];
}

/**
 * Indexed view of links and partitions.
 *
 * Kept separate from the network simulator so that "can A reach B right now?"
 * is a pure question with no randomness and no scheduling, which makes it
 * cheap to test and safe for the UI to call.
 */
export class Topology {
  private readonly links = new Map<LinkId, LinkConfig>();
  /** `from|to` -> link, including the reverse direction of bidirectional links. */
  private readonly byEndpoints = new Map<string, LinkConfig>();
  private readonly outgoing = new Map<NodeId, LinkConfig[]>();
  private partitions: PartitionSpec[] = [];

  constructor(links: readonly LinkConfig[], partitions: readonly PartitionSpec[] = []) {
    for (const link of links) this.addLink(link);
    this.partitions = [...partitions];
  }

  addLink(link: LinkConfig): void {
    this.links.set(link.id, link);
    this.index();
  }

  removeLink(id: LinkId): boolean {
    const removed = this.links.delete(id);
    if (removed) this.index();
    return removed;
  }

  updateLink(id: LinkId, patch: Partial<Omit<LinkConfig, 'id' | 'from' | 'to'>>): LinkConfig | undefined {
    const existing = this.links.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.links.set(id, updated);
    this.index();
    return updated;
  }

  getLink(id: LinkId): LinkConfig | undefined {
    return this.links.get(id);
  }

  allLinks(): readonly LinkConfig[] {
    return [...this.links.values()];
  }

  /** The link that would carry traffic from `from` to `to`, enabled or not. */
  linkFor(from: NodeId, to: NodeId): LinkConfig | undefined {
    return this.byEndpoints.get(`${from}|${to}`);
  }

  /**
   * Links leaving a node, in a stable order. Routing depends on this order, so
   * it is sorted by link id rather than left to insertion chance.
   */
  outgoingFrom(from: NodeId): readonly LinkConfig[] {
    return this.outgoing.get(from) ?? [];
  }

  /**
   * Every node one hop away, whether or not the link is currently up.
   *
   * Distinct from `downstreamOf`: a node with neighbours that are all
   * unreachable is failing, whereas a node with no neighbours at all is simply
   * the end of the chain. Conflating the two makes a load balancer answer
   * requests itself when its whole pool is down.
   */
  neighboursOf(from: NodeId): NodeId[] {
    return this.outgoingFrom(from).map((link) => (link.from === from ? link.to : link.from));
  }

  /**
   * Where a node may send *requests*: the far end of every link drawn from it,
   * enabled or not, in link-id order. Requests follow the direction a link is
   * drawn; `bidirectional` lets responses and protocol traffic come back over
   * it, but never makes the upstream side a place to route work to.
   */
  targetsOf(from: NodeId): NodeId[] {
    return this.outgoingFrom(from)
      .filter((link) => link.from === from)
      .map((link) => link.to);
  }

  /** `targetsOf`, restricted to links that are currently up. */
  enabledTargetsOf(from: NodeId): NodeId[] {
    return this.outgoingFrom(from)
      .filter((link) => link.from === from && link.enabled)
      .map((link) => link.to);
  }

  /** Nodes reachable in one hop over an enabled link. */
  downstreamOf(from: NodeId): NodeId[] {
    return this.outgoingFrom(from)
      .filter((link) => link.enabled)
      .map((link) => (link.from === from ? link.to : link.from));
  }

  setPartitions(partitions: readonly PartitionSpec[]): void {
    this.partitions = [...partitions];
  }

  addPartition(partition: PartitionSpec): void {
    this.partitions = [...this.partitions.filter((p) => p.id !== partition.id), partition];
  }

  removePartition(id: string): boolean {
    const before = this.partitions.length;
    this.partitions = this.partitions.filter((p) => p.id !== id);
    return this.partitions.length !== before;
  }

  activePartitions(): readonly PartitionSpec[] {
    return this.partitions;
  }

  /**
   * True when some partition places the two nodes on different sides.
   * A node named in no group is unaffected, so a partition only has to describe
   * the sides that matter.
   */
  isPartitioned(from: NodeId, to: NodeId): boolean {
    for (const partition of this.partitions) {
      const a = groupIndexOf(partition, from);
      const b = groupIndexOf(partition, to);
      if (a >= 0 && b >= 0 && a !== b) return true;
    }
    return false;
  }

  captureState(): TopologyState {
    return { links: this.allLinks(), partitions: [...this.partitions] };
  }

  restoreState(state: TopologyState): void {
    this.links.clear();
    for (const link of state.links) this.links.set(link.id, link);
    this.partitions = [...state.partitions];
    this.index();
  }

  private index(): void {
    this.byEndpoints.clear();
    this.outgoing.clear();
    const ordered = [...this.links.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const link of ordered) {
      this.byEndpoints.set(`${link.from}|${link.to}`, link);
      pushTo(this.outgoing, link.from, link);
      if (link.bidirectional) {
        this.byEndpoints.set(`${link.to}|${link.from}`, link);
        pushTo(this.outgoing, link.to, link);
      }
    }
  }
}

function groupIndexOf(partition: PartitionSpec, node: NodeId): number {
  return partition.groups.findIndex((group) => group.includes(node));
}

function pushTo(map: Map<NodeId, LinkConfig[]>, key: NodeId, link: LinkConfig): void {
  const list = map.get(key);
  if (list) list.push(link);
  else map.set(key, [link]);
}
