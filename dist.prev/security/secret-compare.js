"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeSecretEqual = safeSecretEqual;
exports.matchesAnySecret = matchesAnySecret;
const node_crypto_1 = __importDefault(require("node:crypto"));
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
function safeSecretEqual(provided, expected) {
    if (typeof provided !== 'string' ||
        typeof expected !== 'string' ||
        provided.length === 0 ||
        expected.length === 0) {
        return false;
    }
    const providedBuf = Buffer.from(provided, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (providedBuf.length === expectedBuf.length) {
        return node_crypto_1.default.timingSafeEqual(providedBuf, expectedBuf);
    }
    // Different lengths: hash both to 32 bytes so timingSafeEqual can still
    // run without leaking which side is longer.
    const providedHash = node_crypto_1.default.createHash('sha256').update(providedBuf).digest();
    const expectedHash = node_crypto_1.default.createHash('sha256').update(expectedBuf).digest();
    // Always run timingSafeEqual, but the result will be false because
    // the original strings differ in length.
    node_crypto_1.default.timingSafeEqual(providedHash, expectedHash);
    return false;
}
/**
 * Check whether `provided` matches any of the candidate secrets.
 *
 * Iterates over every candidate in constant time (no early exit) so an
 * attacker cannot determine how many candidates exist or which one
 * matched based on response timing.
 *
 * Filters out undefined/null/empty candidates before comparison.
 */
function matchesAnySecret(provided, candidates) {
    if (typeof provided !== 'string' || provided.length === 0) {
        return false;
    }
    const validCandidates = candidates.filter((c) => typeof c === 'string' && c.length > 0);
    if (validCandidates.length === 0) {
        return false;
    }
    let matched = false;
    for (const candidate of validCandidates) {
        // Use safeSecretEqual for each candidate — no early exit.
        if (safeSecretEqual(provided, candidate)) {
            matched = true;
        }
    }
    return matched;
}
//# sourceMappingURL=secret-compare.js.map