/**
 * Trust Boundary Route Tests (Phase 05B0)
 *
 * Tests 1-10: Verify that the route auth guards correctly enforce
 * trust boundary separation with dual-key support.
 *
 * Tests:
 *  1. New CongoGaming key accepted on gaming route
 *  2. Legacy GAMING_API_KEY accepted on gaming route during overlap
 *  3. Bridge key rejected on gaming route
 *  4. New Bridge inbound key accepted on internal route
 *  5. CongoGaming key rejected on internal route
 *  6. Legacy GAMING_API_KEY accepted on internal route
 *  7. ADMIN_SECRET comparison timing-safe
 *  8. Empty string rejected
 *  9. Different length rejected
 * 10. No secret value in logs
 *
 * Run with: npx tsx --test src/security/__tests__/trust-boundary.test.ts
 */
export {};
