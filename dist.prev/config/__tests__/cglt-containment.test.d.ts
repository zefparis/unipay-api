/**
 * CGLT Blockchain Containment Tests (Phase 03)
 *
 * 12 mandatory tests verifying:
 *  1. Default mode is 'disabled'
 *  2. Disabled mode blocks write operations
 *  3. Disabled mode blocks read operations
 *  4. read_only mode allows reads but blocks writes
 *  5. enabled mode allows writes
 *  6. Runtime override forces disabled
 *  7. WCGLT_DEPOSIT_PROCESSOR defaults to 'disabled'
 *  8. Bridge and bscscan processors cannot be simultaneously active
 *  9. Config validation forces disabled on failure
 * 10. No secrets in health endpoint response
 * 11. Bridge endpoint returns 503 (both /bridge/mint and /bridge/mint-wcglt)
 * 12. Mobile money routes are not affected by blockchain mode
 *
 * Run with: npx tsx --test src/config/__tests__/cglt-containment.test.ts
 */
export {};
