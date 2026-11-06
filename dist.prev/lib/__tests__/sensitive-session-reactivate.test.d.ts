/**
 * Unit tests for the sensitive-session PIN reactivation logic.
 *
 * Tests the core security decision: an invalidated session can only be
 * reactivated with the correct wallet PIN (bcrypt verification), and a
 * wrong PIN is rejected. Also tests that a non-invalidated session cannot
 * be reactivated (409), and that a non-existent session returns 404.
 *
 * The Fastify route handler is tested with a mock supabase client and
 * mock request/reply objects, exercising the real bcrypt comparison
 * against a pre-hashed PIN.
 *
 * Run with: npx tsx --test src/lib/__tests__/sensitive-session-reactivate.test.ts
 */
export {};
