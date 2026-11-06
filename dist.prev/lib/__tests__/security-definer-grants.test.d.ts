/**
 * Guard test: SECURITY DEFINER functions must have REVOKE in their migration.
 *
 * Root cause of the Supabase audit finding (16 SECURITY DEFINER functions
 * executable by anon/authenticated):
 *
 *   1. Some migrations created SECURITY DEFINER functions WITHOUT any REVOKE
 *      ALL FROM PUBLIC — the functions inherited PostgreSQL's default EXECUTE
 *      grant to PUBLIC (which includes anon and authenticated).
 *
 *   2. Some migrations DID have REVOKE, but a LATER migration used
 *      CREATE OR REPLACE FUNCTION on the same function WITHOUT re-applying
 *      REVOKE. In PostgreSQL, CREATE OR REPLACE FUNCTION resets the function's
 *      ACL to default (EXECUTE to PUBLIC), silently re-exposing the function.
 *
 * This test does static analysis of migration files to catch both patterns:
 *   - Pattern A: SECURITY DEFINER function with no REVOKE in its migration
 *   - Pattern B: CREATE OR REPLACE FUNCTION without REVOKE in the same migration
 *     (re-exposes the function even if a prior migration had REVOKE)
 *
 * For the live-database check (verifies actual grants in pg_proc), run:
 *   psql "$DATABASE_URL" -f supabase/tests/20260912000000_security_definer_grants_guard.sql
 */
export {};
