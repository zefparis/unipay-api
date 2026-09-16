-- ============================================================
-- H1 remediation: merchant payout guard
-- ============================================================
-- Closes the business-logic flaw where any merchant could drain the
-- aggregated Unipesa treasury via direction='payout' without ever
-- having credited their own ledger.
--
-- Three changes:
--   1. grace_until column on merchants (KYC grace period)
--   2. 'payout' type added to merchant_ledger_entries CHECK
--   3. debit_merchant_for_payout RPC (atomic, FOR UPDATE)
--   4. recredit_merchant_payout RPC (atomic, idempotent)
--   5. process_wallet_provider_callback extended to re-credit
--      merchant ledger on failed payout (callback path)
--   6. Backfill grace_until for qualifying merchants
--
-- Does NOT touch existing settlement RPCs (process_merchant_settlement,
-- reject_settlement, mark_settlement_success, mark_settlement_failed).
-- Those remain unchanged and coherent: settlements use type='settlement'
-- (merchant withdrawal of accumulated gains), payouts use type='payout'
-- (disbursement to a third party). Both are debits in the ledger.

-- ── 1. grace_until on merchants ──────────────────────────────
ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS grace_until timestamptz;

COMMENT ON COLUMN public.merchants.grace_until IS
  'KYC grace period deadline. Merchants with kyc_status != ''approved'' can only call payout if grace_until IS NOT NULL AND grace_until > now(). New merchants never get grace_until (blocked immediately). Backfilled once for existing active merchants with real transaction activity.';

-- ── 2. Add 'payout' to merchant_ledger_entries CHECK ──────────
-- The existing constraint allows ('credit', 'settlement').
-- We add 'payout' for disbursements initiated via /payment/initiate.
ALTER TABLE public.merchant_ledger_entries
  DROP CONSTRAINT IF EXISTS merchant_ledger_entries_type_check;

ALTER TABLE public.merchant_ledger_entries
  ADD CONSTRAINT merchant_ledger_entries_type_check
  CHECK (type IN ('credit', 'settlement', 'payout'));

-- ── 3. debit_merchant_for_payout RPC ─────────────────────────
-- Atomically:
--   1. Lock the merchant row (FOR UPDATE)
--   2. Check kyc_status = 'approved' OR grace_until > now()
--   3. Compute available balance (credits - settlements - payouts)
--   4. Validate amount <= balance
--   5. Insert 'payout' ledger entry (debit)
--   6. Return the result
--
-- This mirrors the pattern of process_merchant_settlement (FOR UPDATE,
-- balance computation, validate, insert) to avoid TOCTOU.
CREATE OR REPLACE FUNCTION public.debit_merchant_for_payout(
  p_merchant_id UUID,
  p_transaction_id UUID,
  p_amount NUMERIC,
  p_currency TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_merchant public.merchants%ROWTYPE;
  v_balance NUMERIC := 0;
  v_new_balance NUMERIC := 0;
  v_currency TEXT := upper(p_currency);
BEGIN
  IF v_currency NOT IN ('CDF', 'USD', 'USDT') THEN
    RAISE EXCEPTION 'UNSUPPORTED_CURRENCY: %', p_currency;
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  -- Lock merchant row
  SELECT * INTO v_merchant
  FROM public.merchants
  WHERE id = p_merchant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MERCHANT_NOT_FOUND';
  END IF;

  -- KYC / grace check
  IF v_merchant.kyc_status != 'approved' THEN
    IF v_merchant.grace_until IS NULL OR v_merchant.grace_until <= now() THEN
      RAISE EXCEPTION 'KYC_REQUIRED_FOR_PAYOUT';
    END IF;
  END IF;

  -- Compute available balance for this currency
  SELECT COALESCE(SUM(
    CASE WHEN type = 'credit' THEN amount ELSE -amount END
  ), 0)
  INTO v_balance
  FROM public.merchant_ledger_entries
  WHERE merchant_id = p_merchant_id
    AND currency = v_currency;

  IF p_amount > v_balance THEN
    RAISE EXCEPTION 'INSUFFICIENT_MERCHANT_BALANCE: available %, requested %', v_balance, p_amount;
  END IF;

  -- Insert payout ledger entry (debit)
  v_new_balance := v_balance - p_amount;

  INSERT INTO public.merchant_ledger_entries (
    merchant_id, transaction_id, type, amount, balance_after, currency
  ) VALUES (
    p_merchant_id, p_transaction_id, 'payout', p_amount, v_new_balance, v_currency
  );

  RETURN jsonb_build_object(
    'debited', true,
    'transaction_id', p_transaction_id,
    'amount', p_amount,
    'currency', v_currency,
    'balance_after', v_new_balance
  );
END;
$$;

-- ── 4. recredit_merchant_payout RPC ──────────────────────────
-- Atomically and idempotently re-credits the merchant ledger when
-- a payout fails. Called from initiate.ts (immediate provider error)
-- and from process_wallet_provider_callback (callback path).
--
-- Idempotency: locks the transaction row (FOR UPDATE). If the
-- transaction is already terminal, returns without re-crediting
-- (the callback or a previous call already handled it).
CREATE OR REPLACE FUNCTION public.recredit_merchant_payout(
  p_transaction_id UUID,
  p_reason TEXT DEFAULT 'Payout failed'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx public.transactions%ROWTYPE;
  v_balance NUMERIC := 0;
  v_new_balance NUMERIC := 0;
  v_debit_amount NUMERIC := 0;
BEGIN
  -- Lock the transaction row
  SELECT * INTO v_tx
  FROM public.transactions
  WHERE id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND';
  END IF;

  -- If already terminal, the re-credit was already done (by the
  -- callback or a previous call). Return without doing anything.
  IF v_tx.status IN ('success', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('recredited', false, 'already_terminal', true);
  END IF;

  -- Only re-credit merchant payouts (not wallet user payouts)
  IF v_tx.direction != 'payout' OR v_tx.wallet_user_id IS NOT NULL OR v_tx.merchant_id IS NULL THEN
    RETURN jsonb_build_object('recredited', false, 'not_merchant_payout', true);
  END IF;

  -- Find the original 'payout' debit entry to get the exact amount
  SELECT amount INTO v_debit_amount
  FROM public.merchant_ledger_entries
  WHERE transaction_id = p_transaction_id
    AND type = 'payout'
  LIMIT 1;

  IF v_debit_amount IS NULL OR v_debit_amount = 0 THEN
    -- No debit entry found — nothing to re-credit
    RETURN jsonb_build_object('recredited', false, 'no_payout_debit_found', true);
  END IF;

  -- Re-credit the ledger in the same currency
  SELECT COALESCE(SUM(
    CASE WHEN type = 'credit' THEN amount ELSE -amount END
  ), 0)
  INTO v_balance
  FROM public.merchant_ledger_entries
  WHERE merchant_id = v_tx.merchant_id
    AND currency = upper(v_tx.currency);

  v_new_balance := v_balance + v_debit_amount;

  INSERT INTO public.merchant_ledger_entries (
    merchant_id, transaction_id, type, amount, balance_after, currency
  ) VALUES (
    v_tx.merchant_id, p_transaction_id, 'credit', v_debit_amount,
    v_new_balance, upper(v_tx.currency)
  );

  -- Mark the transaction as failed
  UPDATE public.transactions
  SET status = 'failed',
      updated_at = now()
  WHERE id = p_transaction_id;

  RETURN jsonb_build_object(
    'recredited', true,
    'transaction_id', p_transaction_id,
    'amount', v_debit_amount,
    'currency', upper(v_tx.currency),
    'balance_after', v_new_balance,
    'reason', p_reason
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.debit_merchant_for_payout TO service_role;
GRANT EXECUTE ON FUNCTION public.recredit_merchant_payout TO service_role;

-- ── 5. Extend process_wallet_provider_callback ──────────────
-- Add merchant ledger re-credit on failed payout (callback path).
-- The existing function already handles:
--   - wallet user credits on collect success
--   - wallet user refunds on payout failure
--   - merchant ledger credits on collect success
--   - settlement propagation
-- We add: merchant ledger re-credit on payout failure (for merchant
-- payouts only: wallet_user_id IS NULL, merchant_id IS NOT NULL).
--
-- This is additive — it only fires when direction='payout' AND
-- wallet_user_id IS NULL AND merchant_id IS NOT NULL AND
-- p_new_status='failed'. Existing flows are unaffected.
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

  -- ── Merchant ledger credit on collect success (existing) ──────
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
      v_tx.merchant_id, v_tx.id, 'credit', v_tx.net_amount, v_merchant_balance, upper(v_tx.currency)
    );
  END IF;

  -- ── Merchant ledger re-credit on payout failure (NEW) ────────
  -- When a merchant payout (direction='payout', wallet_user_id IS NULL,
  -- merchant_id IS NOT NULL) fails, re-credit the ledger. The debit
  -- was inserted at initiation time by debit_merchant_for_payout.
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

  -- ── Update transaction status ────────────────────────────────
  UPDATE public.transactions
  SET status = p_new_status,
      avada_transaction_id = COALESCE(p_provider_transaction_id, avada_transaction_id),
      metadata = COALESCE(p_payload, '{}'::jsonb),
      updated_at = now()
  WHERE id = v_tx.id;

  -- ── Settlement propagation (existing) ─────────────────────────
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

-- ── 6. Backfill grace_until ─────────────────────────────────
-- Selects merchants with kyc_status != 'approved' AND at least one
-- successful collect or payout transaction in the last 30 days.
-- This excludes test accounts (IA-SOLUTION, Congo Gaming) that have
-- no real transaction activity.
--
-- ⚠️ This backfill is a SELECT-only preview. The UPDATE is commented
-- out — it must be reviewed and manually applied after validation.
-- To apply: uncomment the UPDATE and re-run this section.

-- Preview the merchants that would be backfilled:
-- SELECT m.id, m.name, m.email, m.kyc_status, m.created_at,
--        count(t.id) AS recent_tx_count
-- FROM public.merchants m
-- JOIN public.transactions t ON t.merchant_id = m.id
-- WHERE m.kyc_status != 'approved'
--   AND t.status = 'success'
--   AND t.direction IN ('collect', 'payout')
--   AND t.created_at >= now() - interval '30 days'
-- GROUP BY m.id, m.name, m.email, m.kyc_status, m.created_at
-- ORDER BY recent_tx_count DESC;

-- To apply the backfill (uncomment after validating the list above):
-- UPDATE public.merchants
-- SET grace_until = now() + interval '7 days'
-- WHERE kyc_status != 'approved'
--   AND id IN (
--     SELECT DISTINCT merchant_id
--     FROM public.transactions
--     WHERE status = 'success'
--       AND direction IN ('collect', 'payout')
--       AND created_at >= now() - interval '30 days'
--   );
