export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}

/**
 * Engine invariant. A violation means the simulation reached a state its own
 * rules say is impossible, so it throws rather than degrading silently — a
 * simulator that quietly produces wrong numbers is worse than one that stops.
 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}
