-- Ensure all balance columns exist on wallet_users
ALTER TABLE public.wallet_users
  ADD COLUMN IF NOT EXISTS balance_cdf   NUMERIC(18,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usd_balance   NUMERIC(18,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cglt_balance  NUMERIC(18,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usdt_balance  NUMERIC(18,6) DEFAULT 0;

-- Atomic swap function: debit one column, credit another, in one transaction.
-- Raises INSUFFICIENT_BALANCE exception if debit column < debit_amount.
CREATE OR REPLACE FUNCTION public.swap_balances(
  p_user_id       UUID,
  p_debit_col     TEXT,
  p_credit_col    TEXT,
  p_debit_amount  NUMERIC,
  p_credit_amount NUMERIC,
  p_fee           NUMERIC DEFAULT 0
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Debit (including fee if any) — atomic check: only updates if balance >= amount
  EXECUTE format(
    'UPDATE public.wallet_users SET %I = %I - $1 WHERE id = $2 AND %I >= $1',
    p_debit_col, p_debit_col, p_debit_col
  ) USING (p_debit_amount + p_fee), p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: % < %', p_debit_col, p_debit_amount + p_fee;
  END IF;

  -- Credit
  EXECUTE format(
    'UPDATE public.wallet_users SET %I = %I + $1 WHERE id = $2',
    p_credit_col, p_credit_col
  ) USING p_credit_amount, p_user_id;
END;
$$;
