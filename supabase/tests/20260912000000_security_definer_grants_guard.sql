-- ════════════════════════════════════════════════════════════════════════════
-- Guard test: SECURITY DEFINER functions must NOT be executable by anon/authenticated
--
-- This script queries the live database (pg_proc + has_function_privilege) to
-- verify that no SECURITY DEFINER function matching the financial whitelist is
-- executable by the anon or authenticated roles.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/20260912000000_security_definer_grants_guard.sql
--
-- Or via Supabase Studio SQL editor.
--
-- The test FAILS (raises an exception) if any matching function has EXECUTE
-- privilege granted to anon or authenticated.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  offending_record RECORD;
  offending_count INTEGER;
BEGIN
  -- Count SECURITY DEFINER functions in public schema matching the financial
  -- whitelist that have EXECUTE privilege granted to anon or authenticated.
  SELECT COUNT(*) INTO offending_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.prosecdef = true  -- SECURITY DEFINER
    AND (
      p.proname LIKE 'wallet_%'
      OR p.proname LIKE 'process_merchant_%'
      OR p.proname LIKE 'process_wallet_%'
      OR p.proname LIKE 'resolve_%'
      OR p.proname LIKE 'mark_%'
      OR p.proname LIKE 'begin_%'
      OR p.proname LIKE 'reject_%'
    )
    AND (
      has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
    );

  IF offending_count > 0 THEN
    -- List the offending functions for debugging
    FOR offending_record IN
      SELECT
        p.proname AS function_name,
        CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'anon' ELSE 'authenticated' END AS exposed_to
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public'
        AND p.prosecdef = true
        AND (
          p.proname LIKE 'wallet_%'
          OR p.proname LIKE 'process_merchant_%'
          OR p.proname LIKE 'process_wallet_%'
          OR p.proname LIKE 'resolve_%'
          OR p.proname LIKE 'mark_%'
          OR p.proname LIKE 'begin_%'
          OR p.proname LIKE 'reject_%'
        )
        AND (
          has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
        )
    LOOP
      RAISE NOTICE 'EXPOSED: %() is executable by %', offending_record.function_name, offending_record.exposed_to;
    END LOOP;

    RAISE EXCEPTION 'GUARD TEST FAILED: % SECURITY DEFINER function(s) matching financial whitelist are executable by anon or authenticated. Run REVOKE ALL ON FUNCTION ... FROM PUBLIC; for each.', offending_count;
  END IF;

  RAISE NOTICE 'GUARD TEST PASSED: No SECURITY DEFINER financial function is executable by anon or authenticated.';
END $$;
