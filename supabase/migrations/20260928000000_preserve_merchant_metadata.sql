-- ============================================================
-- M6 remediation: preserve merchant metadata on provider callback
-- ============================================================
-- The original process_wallet_provider_callback (20260907020100)
-- overwrote the merchant's metadata with the provider's payload:
--   metadata = COALESCE(p_payload, '{}'::jsonb)
--
-- This destroyed the merchant's business context (client reference,
-- internal note, etc.) that was stored at initiation time.
--
-- Fix: instead of overwriting, merge the two with distinct keys:
--   - merchant_metadata: the original metadata from initiation
--   - provider_payload: the raw payload from the provider callback
--
-- This preserves the audit trail for dispute resolution.

CREATE OR REPLACE FUNCTION public.process_wallet_provider_callback(
  p_provider TEXT,
  p_provider_event_id TEXT,
  p_transaction_id UUID,
  p_new_status TEXT,
  p_provider_transaction_id TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed UUID;
  v_tx public.transactions%ROWTYPE;
  v_credit NUMERIC := 0;
  v_refund NUMERIC := 0;
  v_merchant_balance NUMERIC := 0;
  v_merged_metadata JSONB;
BEGIN
  IF p_provider IS NULL OR p_provider_event_id IS NULL OR p_provider_event_id = '' THEN
    RAISE EXCEPTION 'INVALID_PROVIDER_EVENT';
  END IF;
  IF p_new_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_STATUS';
  END IF;

  INSERT INTO public.provider_webhook_events (
    provider, provider_event_id, transaction_id, payload
  ) VALUES (
    p_provider, p_provider_event_id, p_transaction_id, COALESCE(p_payload, '{}'::jsonb)
  )
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING id INTO v_claimed;

  IF v_claimed IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'duplicate', true);
  END IF;

  SELECT * INTO v_tx
  FROM public.transactions
  WHERE id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND';
  END IF;

  IF v_tx.status IN ('success', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('processed', false, 'already_terminal', true);
  END IF;

  -- ── Wallet user credits/refunds (existing logic) ──────────────
  IF p_new_status = 'success' AND v_tx.direction = 'collect' AND v_tx.wallet_user_id IS NOT NULL THEN
    v_credit := v_tx.net_amount;
    IF upper(v_tx.currency) = 'CDF' THEN
      UPDATE public.wallet_users
      SET balance_cdf = balance_cdf + v_credit, updated_at = now()
      WHERE id = v_tx.wallet_user_id;
    ELSIF upper(v_tx.currency) = 'USD' THEN
      UPDATE public.wallet_users
      SET usd_balance = usd_balance + v_credit, updated_at = now()
      WHERE id = v_tx.wallet_user_id;
    ELSIF upper(v_tx.currency) = 'USDT' THEN
      UPDATE public.wallet_users
      SET usdt_balance = usdt_balance + v_credit, updated_at = now()
      WHERE id = v_tx.wallet_user_id;
    ELSE
      RAISE EXCEPTION 'UNSUPPORTED_WALLET_CURRENCY: %', v_tx.currency;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;
  ELSIF p_new_status = 'failed' AND v_tx.direction = 'payout' AND v_tx.wallet_user_id IS NOT NULL THEN
    v_refund := v_tx.amount + v_tx.fee;
    IF upper(v_tx.currency) = 'CDF' THEN
      UPDATE public.wallet_users
      SET balance_cdf = balance_cdf + v_refund, updated_at = now()
      WHERE id = v_tx.wallet_user_id;
    ELSIF upper(v_tx.currency) = 'USD' THEN
      UPDATE public.wallet_users
      SET usd_balance = usd_balance + v_refund, updated_at = now()
      WHERE id = v_tx.wallet_user_id;
    ELSE
      RAISE EXCEPTION 'UNSUPPORTED_WALLET_CURRENCY: %', v_tx.currency;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;
  END IF;

  -- ── Merchant ledger credit (existing) ────────────────────────
  IF p_new_status = 'success' AND v_tx.direction = 'collect'
     AND v_tx.wallet_user_id IS NULL AND v_tx.merchant_id IS NOT NULL THEN

    SELECT COALESCE(SUM(
      CASE WHEN type = 'credit' THEN amount ELSE -amount END
    ), 0)
    INTO v_merchant_balance
    FROM public.merchant_ledger_entries
    WHERE merchant_id = v_tx.merchant_id;

    v_merchant_balance := v_merchant_balance + v_tx.net_amount;

    INSERT INTO public.merchant_ledger_entries (
      merchant_id, transaction_id, type, amount, balance_after
    ) VALUES (
      v_tx.merchant_id, v_tx.id, 'credit', v_tx.net_amount, v_merchant_balance
    );
  END IF;

  -- ── Update transaction status (M6 fix: merge metadata, don't overwrite) ──
  -- Preserve the merchant's original metadata under 'merchant_metadata'
  -- and store the provider's payload under 'provider_payload'.
  -- If the transaction had no prior metadata, merchant_metadata is null.
  -- If the provider sent no payload, provider_payload is null.
  v_merged_metadata := jsonb_build_object(
    'merchant_metadata', v_tx.metadata,
    'provider_payload', COALESCE(p_payload, null)
  );

  UPDATE public.transactions
  SET status = p_new_status,
      avada_transaction_id = COALESCE(p_provider_transaction_id, avada_transaction_id),
      metadata = v_merged_metadata,
      updated_at = now()
  WHERE id = v_tx.id;

  RETURN jsonb_build_object(
    'processed', true,
    'duplicate', false,
    'credited', v_credit,
    'refunded', v_refund,
    'status', p_new_status,
    'merchant_ledger_credited',
      (p_new_status = 'success' AND v_tx.direction = 'collect'
       AND v_tx.wallet_user_id IS NULL AND v_tx.merchant_id IS NOT NULL)
  );
END;
$$;
