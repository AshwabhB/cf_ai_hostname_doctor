// The verification backoff, as pure functions so the workflow and its tests agree.
import { LIMITS } from "../config/limits";

// Seconds to sleep after a failed attempt (0-based).
export function backoffSeconds(attempt: number): number {
  const { backoffSeconds: early, steadyBackoffSeconds } = LIMITS.verify;
  return attempt < early.length ? early[attempt] : steadyBackoffSeconds;
}

// Seconds to sleep after this failed attempt, or null when the sleeps so far already add
// up to the give-up time. Counted from the schedule, never from the clock.
export function sleepAfter(attempt: number): number | null {
  let slept = 0;
  for (let i = 0; i < attempt; i++) slept += backoffSeconds(i);
  return slept < LIMITS.verify.giveUpAfterSeconds
    ? backoffSeconds(attempt)
    : null;
}

// Worst-case step count: attempts that never verify, each with a dns and a record step,
// the sleeps between them, plus load, claim, settle and activate or release-unsettled
// (give-up replaces those three when nothing verifies, so 4 covers both paths).
export function worstCaseSteps(): {
  attempts: number;
  sleeps: number;
  steps: number;
} {
  let attempts = 1;
  let sleeps = 0;
  while (sleepAfter(attempts - 1) !== null) {
    sleeps++;
    attempts++;
  }
  return { attempts, sleeps, steps: attempts * 2 + sleeps + 4 };
}
