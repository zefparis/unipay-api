/**
 * Centralized constant-time secret comparison helper.
 *
 * All inter-service API key and admin secret checks MUST route through
 * these functions to avoid timing side-channels and code duplication.
 *
 * Invariants:
 * - Never normalizes, trims, or logs secret values.
 * - Handles different-length inputs without early-exit leakage.
 * - Rejects undefined, null, and empty strings.
 */
/**
 * Compare two secret strings in constant time.
 *
 * Returns true only when both values are non-empty strings of equal
 * length with identical content (verified via crypto.timingSafeEqual).
 *
 * Different-length inputs are hashed to equal-length buffers before
 * comparison so the timing does not reveal the expected secret length.
 */
export declare function safeSecretEqual(provided: unknown, expected: unknown): boolean;
/**
 * Check whether `provided` matches any of the candidate secrets.
 *
 * Iterates over every candidate in constant time (no early exit) so an
 * attacker cannot determine how many candidates exist or which one
 * matched based on response timing.
 *
 * Filters out undefined/null/empty candidates before comparison.
 */
export declare function matchesAnySecret(provided: unknown, candidates: (string | undefined | null)[]): boolean;
