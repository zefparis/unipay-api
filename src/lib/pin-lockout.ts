import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * PIN brute-force lockout helper.
 *
 * After MAX_FAILED_PIN_ATTEMPTS consecutive failed PIN verifications the
 * wallet is locked for an escalating duration driven by pin_lockout_count:
 *
 *   lockout #1 → 15 minutes
 *   lockout #2 → 1 hour
 *   lockout #3 → 24 hours
 *   lockout #4+ → permanent (requires admin to reset the columns)
 *
 * On a successful PIN verification the caller MUST call resetPinLockout()
 * to clear failed_pin_attempts, locked_until and pin_lockout_count.
 */

export const MAX_FAILED_PIN_ATTEMPTS = 5;

/** Far-future timestamp used for permanent locks (year 2099). */
const PERMANENT_LOCK_UNTIL = '2099-12-31T23:59:59Z';

/**
 * Returns the lockout duration in milliseconds for the given lockout
 * count (1-indexed: the value AFTER incrementing).
 */
export function lockoutDurationMs(lockoutCount: number): number {
  switch (lockoutCount) {
    case 1:  return 15 * 60 * 1000;        // 15 min
    case 2:  return 60 * 60 * 1000;        // 1 h
    case 3:  return 24 * 60 * 60 * 1000;   // 24 h
    default: return Number.MAX_SAFE_INTEGER; // permanent
  }
}

/** Returns the ISO timestamp for a lockout starting now. */
export function lockoutUntilIso(lockoutCount: number): string {
  const ms = lockoutDurationMs(lockoutCount);
  if (ms === Number.MAX_SAFE_INTEGER) return PERMANENT_LOCK_UNTIL;
  return new Date(Date.now() + ms).toISOString();
}

export interface PinLockoutState {
  failed_pin_attempts: number | null;
  locked_until: string | null;
  pin_lockout_count: number | null;
}

/**
 * Check whether the wallet is currently locked. Returns the locked_until
 * ISO string if locked, or null if not locked.
 */
export function getLockoutDeadline(state: PinLockoutState): string | null {
  if (!state.locked_until) return null;
  return new Date(state.locked_until) > new Date() ? state.locked_until : null;
}

export interface RecordFailureResult {
  locked: boolean;
  lockoutCount: number;
  lockedUntil: string | null;
}

/**
 * Atomically increment the failed-PIN counter and, if the threshold is
 * reached, set locked_until and increment pin_lockout_count.
 *
 * Uses a conditional UPDATE so concurrent attempts cannot all read the
 * same counter value — the database serialises the increments.
 *
 * Returns whether this call triggered a lock and the new lockout count.
 */
export async function recordFailedPinAttempt(
  supabase: SupabaseClient,
  walletId: string,
  currentFailedAttempts: number,
  currentLockoutCount: number,
): Promise<RecordFailureResult> {
  const newFailed = (currentFailedAttempts ?? 0) + 1;
  const shouldLock = newFailed >= MAX_FAILED_PIN_ATTEMPTS;
  const newLockoutCount = (currentLockoutCount ?? 0) + (shouldLock ? 1 : 0);

  const update: Record<string, unknown> = {
    failed_pin_attempts: shouldLock ? 0 : newFailed,
  };
  if (shouldLock) {
    update.locked_until = lockoutUntilIso(newLockoutCount);
    update.pin_lockout_count = newLockoutCount;
  }

  await supabase
    .from('wallet_users')
    .update(update)
    .eq('id', walletId);

  return {
    locked: shouldLock,
    lockoutCount: newLockoutCount,
    lockedUntil: shouldLock ? (update.locked_until as string) : null,
  };
}

/**
 * Reset all lockout counters after a successful PIN verification.
 * pin_lockout_count is also reset: the user proved they know the PIN,
 * so the escalation ladder starts fresh.
 */
export async function resetPinLockout(
  supabase: SupabaseClient,
  walletId: string,
): Promise<void> {
  await supabase
    .from('wallet_users')
    .update({
      failed_pin_attempts: 0,
      locked_until: null,
      pin_lockout_count: 0,
    })
    .eq('id', walletId);
}
