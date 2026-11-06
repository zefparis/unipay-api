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
export declare const MAX_FAILED_PIN_ATTEMPTS = 5;
/**
 * Returns the lockout duration in milliseconds for the given lockout
 * count (1-indexed: the value AFTER incrementing).
 */
export declare function lockoutDurationMs(lockoutCount: number): number;
/** Returns the ISO timestamp for a lockout starting now. */
export declare function lockoutUntilIso(lockoutCount: number): string;
export interface PinLockoutState {
    failed_pin_attempts: number | null;
    locked_until: string | null;
    pin_lockout_count: number | null;
}
/**
 * Check whether the wallet is currently locked. Returns the locked_until
 * ISO string if locked, or null if not locked.
 */
export declare function getLockoutDeadline(state: PinLockoutState): string | null;
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
export declare function recordFailedPinAttempt(supabase: SupabaseClient, walletId: string, currentFailedAttempts: number, currentLockoutCount: number): Promise<RecordFailureResult>;
/**
 * Reset all lockout counters after a successful PIN verification.
 * pin_lockout_count is also reset: the user proved they know the PIN,
 * so the escalation ladder starts fresh.
 */
export declare function resetPinLockout(supabase: SupabaseClient, walletId: string): Promise<void>;
