-- ============================================================
-- Migration: wallet atomic RPC functions
-- Version   : 20260606000001
-- ============================================================

-- ── Retrait atomique ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION wallet_debit(
  p_user_id uuid,
  p_amount  numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wallet_users
  SET balance_cdf = balance_cdf - p_amount,
      updated_at  = now()
  WHERE id            = p_user_id
    AND balance_cdf   >= p_amount
    AND is_active     = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;
END;
$$;

-- ── Transfert P2P atomique ────────────────────────────────────
CREATE OR REPLACE FUNCTION wallet_p2p(
  p_sender_id   uuid,
  p_receiver_id uuid,
  p_amount      numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wallet_users
  SET balance_cdf = balance_cdf - p_amount,
      updated_at  = now()
  WHERE id          = p_sender_id
    AND balance_cdf >= p_amount
    AND is_active   = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;
  UPDATE wallet_users
  SET balance_cdf = balance_cdf + p_amount,
      updated_at  = now()
  WHERE id        = p_receiver_id
    AND is_active = true;
END;
$$;
