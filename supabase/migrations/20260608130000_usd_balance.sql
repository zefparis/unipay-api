-- ============================================================
-- Migration: USD balance column + atomic RPC helpers
-- Version   : 20260608130000
-- ============================================================

-- ── Column: wallet_users.usd_balance ────────────────────────
ALTER TABLE wallet_users
  ADD COLUMN IF NOT EXISTS usd_balance NUMERIC(20, 8) DEFAULT 0;

-- ── Atomic USD debit (used by /wallet/unipesa/withdraw) ─────
CREATE OR REPLACE FUNCTION wallet_debit_usd(
  p_user_id uuid,
  p_amount  numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wallet_users
  SET usd_balance = usd_balance - p_amount,
      updated_at  = now()
  WHERE id            = p_user_id
    AND usd_balance   >= p_amount
    AND is_active     = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;
END;
$$;

-- ── Atomic USD credit (used by /wallet/unipesa/callback) ────
CREATE OR REPLACE FUNCTION wallet_credit_usd(
  p_user_id uuid,
  p_amount  numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wallet_users
  SET usd_balance = usd_balance + p_amount,
      updated_at  = now()
  WHERE id = p_user_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;
END;
$$;
