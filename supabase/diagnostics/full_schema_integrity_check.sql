-- ════════════════════════════════════════════════════════════════════════════
-- Full Schema Integrity Check (non-destructive, read-only)
-- Run after supabase db reset to verify complete schema state.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. All public tables
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;

-- 2. All foreign keys with type compatibility check
SELECT
  tc.table_name,
  kcu.column_name,
  ccu.table_name  AS foreign_table,
  ccu.column_name AS foreign_column,
  a.data_type     AS local_type,
  b.data_type     AS foreign_type,
  CASE WHEN a.data_type = b.data_type THEN 'OK' ELSE 'MISMATCH' END AS type_check
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
JOIN information_schema.columns a ON a.table_schema = tc.table_schema AND a.table_name = kcu.table_name AND a.column_name = kcu.column_name
JOIN information_schema.columns b ON b.table_schema = ccu.table_schema AND b.table_name = ccu.table_name AND b.column_name = ccu.column_name
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
ORDER BY tc.table_name;

-- 3. All views
SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY viewname;

-- 4. All RPC functions
SELECT p.proname, p.prosecdef AS security_definer,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'transition_expense','confirm_settlement','create_settlement_with_audit',
    'resolve_migration_review_with_audit','refresh_snapshot_with_audit',
    'sum_completed_settlements','wallet_debit','wallet_p2p','wallet_p2p_usdt',
    'wallet_debit_usd','wallet_credit_usd','wallet_credit_usdt','swap_balances'
  )
ORDER BY p.proname;

-- 5. RLS status on all tables
SELECT relname, relrowsecurity
FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
ORDER BY relname;

-- 6. Enum types
SELECT t.typname, e.enumlabel
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
WHERE t.typnamespace = 'public'::regnamespace
ORDER BY t.typname, e.enumsortorder;

-- 7. bank_details column exists but is excluded from API
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'expense_entities' AND column_name = 'bank_details';

-- 8. Check that operators.id is uuid (not text)
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'operators' AND column_name = 'id';

-- 9. Check that transactions.merchant_id is uuid (not text)
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'merchant_id';

-- 10. wallet_users has email and lang columns
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'wallet_users' AND column_name IN ('email','lang')
ORDER BY column_name;

-- 11. adi_deposit_events table exists
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'adi_deposit_events') AS adi_deposit_events_exists;
