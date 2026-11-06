/**
 * Unit tests for address-guard.ts
 *
 * Run with:  npm test
 *   (uses node:test + tsx — no extra test runner required)
 *
 * Covers the FORBIDDEN_ADDRESSES + format guards without requiring a live
 * Supabase client or BSC provider (supabase: null skips the whitelist,
 * and forbidden/invalid addresses are rejected before the on-chain check).
 */
export {};
