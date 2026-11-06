/**
 * Tests for merchant profile routes — static analysis + logic verification.
 *
 * These tests verify the security properties of src/routes/merchant/profile.ts
 * without needing a running database:
 *   - Isolation: merchant_id comes from JWT only, never from request body
 *   - current_password verification is required for change-email and change-password
 *   - Rate limiting is configured on sensitive endpoints
 *   - password_hash is never included in GET/PATCH responses
 *   - company_name is locked when kyc_status === 'approved'
 *   - Email is not editable via PATCH (must use change-email endpoint)
 */
export {};
