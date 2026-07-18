-- ════════════════════════════════════════════════════════════════════════════
-- Migration: 20260718190000_dev_expenses_v4_rpc.sql
-- Purpose  : RPC function for summing completed settlements (avoids float issues)
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.sum_completed_settlements(p_expense_id UUID)
RETURNS NUMERIC(14,2) AS $$
DECLARE
  total NUMERIC(14,2);
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO total
  FROM public.dev_expense_settlements
  WHERE expense_id = p_expense_id
    AND status = 'completed';
  RETURN total;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION public.sum_completed_settlements(UUID) IS
  'Returns the total of completed settlements for a given expense. Used by the V4 service to recalculate settled_amount.';

GRANT EXECUTE ON FUNCTION public.sum_completed_settlements TO service_role;
