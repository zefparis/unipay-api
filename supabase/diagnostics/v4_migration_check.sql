-- ════════════════════════════════════════════════════════════════════════════
-- Migration Diagnostic Query (non-destructive)
-- Run after applying all V4 migrations to verify schema state.
-- Does NOT display personal or banking data.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. expense_entities columns (legal profile + roles)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'expense_entities'
ORDER BY ordinal_position;

-- 2. dev_expenses billing recipient columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'dev_expenses'
  AND column_name IN ('billing_recipient_entity_id', 'billing_recipient_snapshot', 'billing_recipient_reviewed')
ORDER BY column_name;

-- 3. V4 view exists and compiles
SELECT viewname, definition IS NOT NULL AS has_definition
FROM pg_views
WHERE schemaname = 'public'
  AND viewname = 'dev_expenses_v4_view';

-- 4. RPC functions exist
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'transition_expense',
    'confirm_settlement',
    'create_settlement_with_audit',
    'resolve_migration_review_with_audit',
    'refresh_snapshot_with_audit',
    'sum_completed_settlements'
  )
ORDER BY routine_name;

-- 5. Five role capabilities present
SELECT
  COUNT(*) FILTER (WHERE column_name = 'can_incur_expenses')          AS has_can_incur,
  COUNT(*) FILTER (WHERE column_name = 'can_receive_invoices')        AS has_can_receive_invoices,
  COUNT(*) FILTER (WHERE column_name = 'can_pay_expenses')            AS has_can_pay_expenses,
  COUNT(*) FILTER (WHERE column_name = 'can_cover_expenses')          AS has_can_cover_expenses,
  COUNT(*) FILTER (WHERE column_name = 'can_receive_reimbursements')  AS has_can_receive_reimbursements
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'expense_entities';

-- 6. Legacy views still exist
SELECT viewname
FROM pg_views
WHERE schemaname = 'public'
  AND viewname IN ('dev_expenses_v4_view', 'dev_expenses_view')
ORDER BY viewname;

-- 7. bank_details is NOT in any select or snapshot (verify column exists but is excluded from API)
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'expense_entities'
  AND column_name = 'bank_details';

-- 8. GRANT EXECUTE on all RPC functions to service_role
SELECT p.proname AS routine_name,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS has_execute_privilege
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'transition_expense',
    'confirm_settlement',
    'create_settlement_with_audit',
    'resolve_migration_review_with_audit',
    'refresh_snapshot_with_audit',
    'sum_completed_settlements'
  )
ORDER BY p.proname;

-- 9. SECURITY DEFINER + search_path verification
SELECT routine_name, security_type, routine_definition
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'transition_expense',
    'confirm_settlement',
    'create_settlement_with_audit',
    'resolve_migration_review_with_audit',
    'refresh_snapshot_with_audit',
    'sum_completed_settlements'
  )
ORDER BY routine_name;

-- 10. dev_expense_settlements columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'dev_expense_settlements'
ORDER BY ordinal_position;

-- 11. dev_expense_audit_events columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'dev_expense_audit_events'
ORDER BY ordinal_position;

-- 12. RLS status on V4 tables
SELECT relname, relrowsecurity
FROM pg_class
WHERE relname IN ('expense_entities', 'dev_expenses', 'dev_expense_settlements', 'dev_expense_audit_events')
  AND relnamespace = 'public'::regnamespace
ORDER BY relname;

-- 13. Enum types
SELECT t.typname, e.enumlabel
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
WHERE t.typname IN ('dev_expense_status_v4', 'dev_expense_settlement_type', 'dev_expense_settlement_status', 'dev_expense_audit_event_type')
ORDER BY t.typname, e.enumsortorder;
