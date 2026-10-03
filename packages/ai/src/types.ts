/**
 * The vocabulary every explanation is written in.
 *
 * A fact is one of three things and says which: something the simulation
 * measured (and the events that show it), something the scenario configured,
 * or arithmetic on those. Interpretation — anything heuristic — is kept apart
 * and labelled, so a reader can always tell what was observed from what is
 * being suggested.
 */
export type FactKind = 'measured' | 'configured' | 'derived';

export interface Fact {
  readonly kind: FactKind;
  readonly text: string;
  /** The events this fact rests on, oldest first. Empty for configured facts. */
  readonly eventIds: readonly string[];
}

export interface Explanation {
  readonly title: string;
  /** A short answer composed only of the facts below. */
  readonly summary: string;
  readonly facts: readonly Fact[];
  /** Heuristic reading of the facts — never presented as measurement. */
  readonly interpretation: readonly string[];
  /** What to try next, phrased as experiments rather than verdicts. */
  readonly suggestions: readonly string[];
}

export const measured = (text: string, ...eventIds: string[]): Fact => ({ kind: 'measured', text, eventIds });
export const configured = (text: string): Fact => ({ kind: 'configured', text, eventIds: [] });
export const derived = (text: string, ...eventIds: string[]): Fact => ({ kind: 'derived', text, eventIds });
