-- ============================================================
-- Migration: wallet_credit_usdt RPC
-- Version   : 20260629000000
-- Reason    : BSC on-chain USDT/wCGLT deposits must credit
--             usdt_balance (crypto), not usd_balance (fiat).
-- ============================================================

CREATE OR REPLACE FUNCTION wallet_credit_usdt(
  p_user_id uuid,
  p_amount  numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wallet_users
  SET usdt_balance = usdt_balance + p_amount,
      updated_at   = now()
  WHERE id = p_user_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;
END;
$$;
