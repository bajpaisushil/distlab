/**
 * Circuit breaker state machine.
 *
 *   CLOSED ──(too many failures)──▶ OPEN ──(cooldown elapsed)──▶ HALF_OPEN
 *     ▲                                ▲                            │
 *     └──────(probe succeeded)─────────┼────(probe failed)──────────┘
 *
 * Transitions out of OPEN are evaluated when a call is attempted rather than
 * on a timer, as most real implementations do: a circuit stays open until
 * someone wants to use it after the cooldown.
 */

export type BreakerMode = 'closed' | 'open' | 'half_open';

export interface BreakerPolicy {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenMaxCalls: number;
  /** Rate mode when set: open on this share of failures within the window. */
  readonly failureRateThreshold?: number;
  readonly windowMs?: number;
  readonly minimumRequests: number;
}

export interface BreakerState {
  readonly mode: BreakerMode;
  readonly consecutiveFailures: number;
  readonly openedAt: number;
  readonly halfOpenInFlight: number;
  /** Rate mode: recent outcomes inside the window. */
  readonly outcomes: readonly { readonly at: number; readonly ok: boolean }[];
}

export const CLOSED: BreakerState = {
  mode: 'closed',
  consecutiveFailures: 0,
  openedAt: 0,
  halfOpenInFlight: 0,
  outcomes: [],
};

export type BreakerTransition =
  | { readonly kind: 'opened'; readonly failures: number; readonly calls?: number; readonly reopened: boolean }
  | { readonly kind: 'half_opened'; readonly openForMs: number }
  | { readonly kind: 'closed' };

/** Whether a call may go out now. A permitted half-open call counts as a probe in flight. */
export function permit(
  policy: BreakerPolicy,
  state: BreakerState,
  now: number,
): { allowed: boolean; state: BreakerState; transition?: BreakerTransition } {
  if (state.mode === 'closed') return { allowed: true, state };
  if (state.mode === 'open') {
    if (now - state.openedAt < policy.cooldownMs) return { allowed: false, state };
    const halfOpen: BreakerState = { ...state, mode: 'half_open', halfOpenInFlight: 1 };
    return { allowed: true, state: halfOpen, transition: { kind: 'half_opened', openForMs: now - state.openedAt } };
  }
  if (state.halfOpenInFlight < policy.halfOpenMaxCalls) {
    return { allowed: true, state: { ...state, halfOpenInFlight: state.halfOpenInFlight + 1 } };
  }
  return { allowed: false, state };
}

/** Whether the circuit would let a call through, without counting one. */
export function wouldPermit(policy: BreakerPolicy, state: BreakerState, now: number): boolean {
  if (state.mode === 'closed') return true;
  if (state.mode === 'open') return now - state.openedAt >= policy.cooldownMs;
  return state.halfOpenInFlight < policy.halfOpenMaxCalls;
}

export function record(
  policy: BreakerPolicy,
  state: BreakerState,
  now: number,
  ok: boolean,
): { state: BreakerState; transition?: BreakerTransition } {
  if (state.mode === 'half_open') {
    const inFlight = Math.max(0, state.halfOpenInFlight - 1);
    if (ok) return { state: CLOSED, transition: { kind: 'closed' } };
    return {
      state: { ...CLOSED, mode: 'open', openedAt: now, consecutiveFailures: state.consecutiveFailures + 1, halfOpenInFlight: inFlight },
      transition: { kind: 'opened', failures: state.consecutiveFailures + 1, reopened: true },
    };
  }
  // Outcomes that land while open (calls made before it opened) change nothing.
  if (state.mode === 'open') return { state };

  if (policy.failureRateThreshold !== undefined && policy.windowMs !== undefined) {
    const outcomes = [...state.outcomes.filter((o) => now - o.at < policy.windowMs!), { at: now, ok }];
    const failures = outcomes.filter((o) => !o.ok).length;
    if (!ok && outcomes.length >= policy.minimumRequests && failures / outcomes.length >= policy.failureRateThreshold) {
      return {
        state: { ...CLOSED, mode: 'open', openedAt: now, consecutiveFailures: state.consecutiveFailures + 1 },
        transition: { kind: 'opened', failures, calls: outcomes.length, reopened: false },
      };
    }
    return { state: { ...state, outcomes, consecutiveFailures: ok ? 0 : state.consecutiveFailures + 1 } };
  }

  const consecutive = ok ? 0 : state.consecutiveFailures + 1;
  if (consecutive >= policy.failureThreshold) {
    return {
      state: { ...CLOSED, mode: 'open', openedAt: now, consecutiveFailures: consecutive },
      transition: { kind: 'opened', failures: consecutive, reopened: false },
    };
  }
  return { state: { ...state, consecutiveFailures: consecutive } };
}

/** A permitted half-open probe that never produced an outcome (e.g. abandoned) frees its slot. */
export function releaseProbe(state: BreakerState): BreakerState {
  return state.mode === 'half_open' ? { ...state, halfOpenInFlight: Math.max(0, state.halfOpenInFlight - 1) } : state;
}
