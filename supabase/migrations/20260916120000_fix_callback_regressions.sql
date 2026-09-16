-- ============================================================
-- Fix callback regressions introduced by 20260928000000_preserve_merchant_metadata
-- ============================================================
-- The M6 rewrite of process_wallet_provider_callback was built from
-- an older version of the function and silently dropped three blocks
-- that 20260922000000_merchant_payout_guard had added/kept:
--
--   1. Settlement propagation — when the resolved transaction has a
--      settlement_request_id, the linked merchant_settlement_requests
--      row must be marked success/failed (with ledger re-credit on
--      failure). Without it, settlements stay 'processing' forever and
--      failed settlements are never re-credited.
--   2. Merchant ledger re-credit on failed payout — merchant payouts
--      initiated via /payment/initiate (direction='payout', no
--      settlement link) were debited by debit_merchant_for_payout at
--      initiation; an async failure (callback or reconciliation) must
--      re-credit the ledger. The synchronous failure path in
--      initiate.ts calls recredit_merchant_payout directly and is
--      unaffected.
--   3. Currency filter + column on collect credit — the M6 version
--      computed v_merchant_balance over ALL currencies and inserted
--      the credit entry without the currency column (falling back to
--      DEFAULT 'CDF'), which would mislabel USD credits and produce
--      mixed-currency balance_after values.
--
-- This migration redefines the function starting FROM the deployed
-- 20260928000000 version (keeping the M6 merchant_metadata /
-- provider_payload merge) and restores the three dropped blocks.
-- It is NOT a rollback to 20260922000000.

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
  v_merchant_recredit NUMERIC := 0;
  v_settlement_updated BOOLEAN := false;
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

  -- ── Merchant ledger credit on collect success ────────────────
  -- Restored: per-currency balance + explicit currency column.
  -- Without the filter, balance_after mixed CDF+USD+USDT; without the
  -- column, USD credits were stored with currency='CDF' (the DEFAULT).
  IF p_new_status = 'success' AND v_tx.direction = 'collect'
     AND v_tx.wallet_user_id IS NULL AND v_tx.merchant_id IS NOT NULL THEN

    SELECT COALESCE(SUM(
      CASE WHEN type = 'credit' THEN amount ELSE -amount END
    ), 0)
    INTO v_merchant_balance
    FROM public.merchant_ledger_entries
    WHERE merchant_id = v_tx.merchant_id
      AND currency = upper(v_tx.currency);

    v_merchant_balance := v_merchant_balance + v_tx.net_amount;

    INSERT INTO public.merchant_ledger_entries (
      merchant_id, transaction_id, type, amount, balance_after, currency
    ) VALUES (
      v_tx.merchant_id, v_tx.id, 'credit', v_tx.net_amount,
      v_merchant_balance, upper(v_tx.currency)
    );
  END IF;

  -- ── Merchant ledger re-credit on payout failure (restored) ────
  -- When a merchant payout (direction='payout', wallet_user_id IS NULL,
  -- merchant_id IS NOT NULL) fails, re-credit the ledger. The debit
  -- was inserted at initiation time by debit_merchant_for_payout.
  -- The synchronous initiation-failure path in initiate.ts uses
  -- recredit_merchant_payout directly; this block covers the async
  -- path (inbound callback + reconciliation worker).
  IF p_new_status = 'failed' AND v_tx.direction = 'payout'
     AND v_tx.wallet_user_id IS NULL AND v_tx.merchant_id IS NOT NULL THEN

    SELECT amount INTO v_merchant_recredit
    FROM public.merchant_ledger_entries
    WHERE transaction_id = v_tx.id
      AND type = 'payout'
    LIMIT 1;

    IF v_merchant_recredit IS NOT NULL AND v_merchant_recredit > 0 THEN
      SELECT COALESCE(SUM(
        CASE WHEN type = 'credit' THEN amount ELSE -amount END
      ), 0)
      INTO v_merchant_balance
      FROM public.merchant_ledger_entries
      WHERE merchant_id = v_tx.merchant_id
        AND currency = upper(v_tx.currency);

      v_merchant_balance := v_merchant_balance + v_merchant_recredit;

      INSERT INTO public.merchant_ledger_entries (
        merchant_id, transaction_id, type, amount, balance_after, currency
      ) VALUES (
        v_tx.merchant_id, v_tx.id, 'credit', v_merchant_recredit,
        v_merchant_balance, upper(v_tx.currency)
      );
    END IF;
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

  -- ── Settlement propagation (restored) ─────────────────────────
  -- If this transaction is linked to a settlement request, propagate
  -- the terminal status. mark_settlement_failed re-credits the
  -- merchant ledger (the settlement was debited at creation time).
  -- mark_settlement_success stores the provider_ref and marks the
  -- settlement as complete.
  --
  -- Errors are caught so a terminal settlement (e.g. already resolved
  -- by a previous callback or manual fix) does not roll back the
  -- transaction status update.
  IF v_tx.settlement_request_id IS NOT NULL THEN
    IF p_new_status = 'success' THEN
      BEGIN
        PERFORM public.mark_settlement_success(
          v_tx.settlement_request_id,
          COALESCE(p_provider_transaction_id, v_tx.avada_transaction_id)
        );
        v_settlement_updated := true;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Settlement % mark_success skipped: %',
          v_tx.settlement_request_id, SQLERRM;
      END;
    ELSIF p_new_status = 'failed' THEN
      BEGIN
        PERFORM public.mark_settlement_failed(
          v_tx.settlement_request_id,
          'Provider callback: payout failed'
        );
        v_settlement_updated := true;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Settlement % mark_failed skipped: %',
          v_tx.settlement_request_id, SQLERRM;
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'processed', true,
    'duplicate', false,
    'credited', v_credit,
    'refunded', v_refund,
    'status', p_new_status,
    'merchant_ledger_credited',
      (p_new_status = 'success' AND v_tx.direction = 'collect'
       AND v_tx.wallet_user_id IS NULL AND v_tx.merchant_id IS NOT NULL),
    'merchant_ledger_recredited',
      (p_new_status = 'failed' AND v_tx.direction = 'payout'
       AND v_tx.wallet_user_id IS NULL AND v_tx.merchant_id IS NOT NULL
       AND v_merchant_recredit > 0),
    'merchant_ledger_currency', upper(v_tx.currency),
    'settlement_updated', v_settlement_updated
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_wallet_provider_callback(TEXT, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_wallet_provider_callback(TEXT, TEXT, UUID, TEXT, TEXT, JSONB) TO service_role;
