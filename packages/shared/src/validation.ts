import type { LinkId, NodeId } from './ids.js';
import type { LatencySpec } from './latency.js';
import type { NodeType } from './nodes.js';

/** Records one problem at a JSON path, e.g. `nodes[2].config.retry.maxRetries`. */
export type IssueReporter = (path: string, message: string) => void;

/** Everything a module validator may cross-reference. */
export interface SpecValidationContext {
  readonly nodeIds: ReadonlySet<NodeId>;
  readonly nodeTypes: ReadonlyMap<NodeId, NodeType>;
  readonly linkIds: ReadonlySet<LinkId>;
  /** Resolved link endpoints, ids already derived. */
  readonly links: readonly { readonly id: LinkId; readonly from: NodeId; readonly to: NodeId }[];
}

export function checkLatency(value: LatencySpec | undefined, path: string, push: IssueReporter): void {
  if (value === undefined) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) push(path, 'latency must be a finite, non-negative number');
    return;
  }
  if (typeof value !== 'object' || value === null) {
    push(path, 'must be a number or latency distribution');
    return;
  }
  switch (value.kind) {
    case 'fixed':
      checkNonNegative(value.value, `${path}.value`, push);
      return;
    case 'uniform':
      checkNonNegative(value.min, `${path}.min`, push);
      checkNonNegative(value.max, `${path}.max`, push);
      if (typeof value.min === 'number' && typeof value.max === 'number' && value.min > value.max) {
        push(path, 'min must not exceed max');
      }
      return;
    case 'normal':
      checkNonNegative(value.mean, `${path}.mean`, push);
      checkNonNegative(value.stddev, `${path}.stddev`, push);
      return;
    case 'exponential':
      checkNonNegative(value.mean, `${path}.mean`, push);
      return;
    default:
      push(`${path}.kind`, `unknown latency kind "${String((value as { kind: string }).kind)}"`);
  }
}

export function checkProbability(value: unknown, path: string, push: IssueReporter): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    push(path, 'must be a probability between 0 and 1');
  }
}

export function checkNonNegative(value: unknown, path: string, push: IssueReporter): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    push(path, 'must be a finite, non-negative number');
  }
}

export function checkPositive(value: unknown, path: string, push: IssueReporter, optional: boolean): void {
  if (value === undefined) {
    if (!optional) push(path, 'is required');
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    push(path, 'must be a finite number greater than 0');
  }
}

export function checkInteger(value: unknown, path: string, push: IssueReporter, min = 0): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    push(path, `must be an integer of at least ${min}`);
  }
}

export function checkOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  push: IssueReporter,
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    push(path, `must be one of ${allowed.map((a) => `"${a}"`).join(', ')}`);
  }
}

export function checkNodeRef(
  value: unknown,
  path: string,
  push: IssueReporter,
  context: SpecValidationContext,
  allowedTypes?: readonly NodeType[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !context.nodeIds.has(value)) {
    push(path, `unknown node "${String(value)}"`);
    return;
  }
  if (allowedTypes && !allowedTypes.includes(context.nodeTypes.get(value) as NodeType)) {
    push(path, `node "${value}" must be one of: ${allowedTypes.join(', ')}`);
  }
}
