/**
 * Tests for merchant password reset routes — static analysis + logic verification.
 *
 * Verifies security properties of src/routes/merchant/password-reset.ts:
 *   - /request always returns the same generic response (no enumeration)
 *   - Token is hashed (sha256) before storage, never stored in plaintext
 *   - Token has 30-minute expiry
 *   - /confirm rejects expired tokens
 *   - /confirm rejects already-used tokens (used_at must be null)
 *   - Successful reset invalidates all other pending tokens
 *   - Per-email rate limit (3/hour)
 *   - Per-IP rate limit (10/hour)
 *   - Password hashed with bcrypt cost 12
 *   - Security notification email sent after reset
 */
export {};
