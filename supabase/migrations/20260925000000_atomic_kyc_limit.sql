-- ============================================================
-- M3 remediation: atomic KYC daily limit + balance debit
-- ============================================================
-- Closes the TOCTOU race in wallet/withdraw.ts where the KYC
-- daily limit was checked in a SELECT, then the balance debited
-- in a separate UPDATE. Two concurrent withdrawal requests could
-- both pass the limit check before either debit was visible.
--
-- This RPC does everything atomically in a single transaction:
--   1. Lock the wallet_users row (FOR UPDATE)
--   2. Compute today's cumulative payout amount
--   3. Check daily limit (passed as parameter — app-side KYC level)
--   4. Check sufficient balance
--   5. Debit the balance
--   6. Return the new balance
--
-- The limit is passed as a parameter (not read from DB) because the
-- KYC level → limit mapping lives in the application (kyc-limits.ts).
-- Passing it as a parameter keeps the RPC generic and avoids
-- duplicating the limit table in the database.

CREATE OR REPLACE FUNCTION public.wallet_debit_with_kyc_limit(
  p_user_id    UUID,
  p_amount     NUMERIC,
  p_daily_limit NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet      public.wallet_users%ROWTYPE;
  v_daily_used  NUMERIC := 0;
  v_new_balance NUMERIC;
  v_day_start   timestamptz;
BEGIN
  -- Compute the start of today (UTC midnight)
  v_day_start := date_trunc('day', now()) AT TIME ZONE 'UTC';

  -- Lock the wallet row
  SELECT * INTO v_wallet
  FROM public.wallet_users
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  IF NOT v_wallet.is_active THEN
    RAISE EXCEPTION 'WALLET_SUSPENDED';
  END IF;

  -- Compute today's cumulative payout (processing + success)
  SELECT COALESCE(SUM(amount), 0) INTO v_daily_used
  FROM public.transactions
  WHERE wallet_user_id = p_user_id
    AND direction = 'payout'
    AND status IN ('processing', 'success')
    AND created_at >= v_day_start;

  -- Check KYC daily limit
  IF v_daily_used + p_amount > p_daily_limit THEN
    RAISE EXCEPTION 'KYC_LIMIT_EXCEEDED: daily_used %, requested %, limit %',
      v_daily_used, p_amount, p_daily_limit;
  END IF;

  -- Check sufficient balance
  IF v_wallet.balance_cdf < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS: balance %, required %',
      v_wallet.balance_cdf, p_amount;
  END IF;

  -- Debit
  v_new_balance := v_wallet.balance_cdf - p_amount;

  UPDATE public.wallet_users
  SET balance_cdf = v_new_balance,
      updated_at = now()
  WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'debited', true,
    'new_balance', v_new_balance,
    'daily_used_before', v_daily_used,
    'daily_used_after', v_daily_used + p_amount,
    'daily_limit', p_daily_limit
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.wallet_debit_with_kyc_limit TO service_role;
