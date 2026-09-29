-- ============================================================
-- Wallet withdraw idempotency — atomic claim + debit + single
-- atomic refund path
-- ============================================================
-- Implements the "claim-first" pattern for POST /v1/wallet/withdraw:
-- the pending transaction row (bound to a client-generated
-- idempotency_key) AND the balance debit happen in ONE atomic
-- database transaction, under a FOR UPDATE lock on wallet_users.
--
-- Guarantees:
--   * Replay (same key, same wallet, same payload): the existing
--     transaction is returned, no re-debit, no new row — regardless
--     of its status (pending/processing/success/failed).
--   * Replay with a DIFFERENT payload (amount/operator/phone/
--     currency): raises IDEMPOTENCY_KEY_REUSED — the route maps it
--     to HTTP 422.
--   * Concurrent same-key requests: serialized by the wallet row
--     lock. The loser blocks on FOR UPDATE, then sees the winner's
--     committed claim row and returns it. The partial unique index
--     is the backstop for any residual path.
--   * Insufficient balance / KYC limit / suspended wallet: guard
--     exceptions fire BEFORE the claim insert, so a raised exception
--     rolls back the whole transaction — nothing is inserted and
--     nothing is debited.
--   * Refund has ONE code path: wallet_withdraw_fail_and_refund.
--     Route-level provider failure, provider callbacks and
--     reconciliation all go through it (the callback RPC delegates).
--     It refunds only while the tx is pending/processing — a second
--     call on a terminal tx never re-credits.
--   * Crash between claim and provider call: leaves a 'pending'
--     row with the debit applied — swept by
--     wallet_withdraw_sweep_orphans (§5) instead of an invisible
--     orphan debit.
--
-- daily_used change vs wallet_debit_with_kyc_limit: the claim row
-- is inserted 'pending' BEFORE the provider call, so between claim
-- and processing transition the debit exists but a 'processing'/
-- 'success'-only SUM would not see it — re-opening the exact M3
-- TOCTOU (two rapid withdrawals both passing the limit). Counting
-- 'pending' claims keeps the guard honest while money is in flight.
-- Cost: a pending claim that fails still counts toward the day until
-- it transitions to 'failed' — conservative and acceptable.
--
-- The old path (wallet_debit_with_kyc_limit + separate insert in
-- withdraw.ts) is left in place until this RPC is validated.

-- ── 1. Column ────────────────────────────────────────────────
-- Nullable, no default → Postgres ≥11 performs a metadata-only
-- rewrite-free ALTER. On ~270 rows this takes an ACCESS EXCLUSIVE
-- lock for microseconds.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- ── 2. Partial unique index ──────────────────────────────────
-- One claim per (wallet, key). NULL keys (legacy/back-office
-- transactions) are exempt by construction.
-- NOTE on locking: a plain CREATE INDEX takes a SHARE lock that
-- blocks writes for the build duration. On ~270 rows this is a few
-- milliseconds — no CONCURRENTLY needed (and CONCURRENTLY would
-- fail if the migration runner wraps this file in a transaction).
-- Reassess only if `transactions` grows past ~1M rows.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_wallet_idempotency_unique
  ON public.transactions (wallet_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── 3. Atomic fail + refund RPC (single transition path) ─────
-- Locks the transaction row, then the wallet row, then — only if
-- the tx is still pending/processing — credits back amount + fee
-- and marks the tx 'failed' in ONE transaction. Any second call
-- (route retry, callback, sweeper) hits the terminal guard and
-- credits nothing.
--
-- Lock order: tx row → wallet row. The claim RPC takes wallet →
-- tx insert; inserts don't need a lock on an existing tx row, so
-- no deadlock cycle exists between the two paths.
CREATE OR REPLACE FUNCTION public.wallet_withdraw_fail_and_refund(
  p_tx_id  UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx     public.transactions%ROWTYPE;
  v_refund NUMERIC := 0;
BEGIN
  SELECT * INTO v_tx
  FROM public.transactions
  WHERE id = p_tx_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND';
  END IF;

  IF v_tx.status IN ('success', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object(
      'refunded',         0,
      'already_terminal', true,
      'status',           v_tx.status
    );
  END IF;

  IF v_tx.direction <> 'payout' OR v_tx.wallet_user_id IS NULL THEN
    RAISE EXCEPTION 'NOT_A_WALLET_PAYOUT';
  END IF;

  v_refund := v_tx.amount + v_tx.fee;

  -- Credit under a wallet row lock (same order as wallet_withdraw_claim).
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

  -- Status transition + refund audit markers, merged (not overwritten).
  UPDATE public.transactions
  SET status = 'failed',
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'refund_reason',   COALESCE(p_reason, 'unspecified'),
        'refunded_amount', v_refund,
        'refunded_at',     now()
      ),
      updated_at = now()
  WHERE id = v_tx.id;

  RETURN jsonb_build_object(
    'refunded',         v_refund,
    'already_terminal', false,
    'status',           'failed'
  );
END;
$$;

-- ── 4. Atomic claim + debit RPC ──────────────────────────────
-- Same guard semantics and exception names as
-- wallet_debit_with_kyc_limit so the caller's error mapping is
-- unchanged: WALLET_NOT_FOUND / WALLET_SUSPENDED /
-- KYC_LIMIT_EXCEEDED / INSUFFICIENT_FUNDS — plus
-- IDEMPOTENCY_KEY_REUSED on payload mismatch.
CREATE OR REPLACE FUNCTION public.wallet_withdraw_claim(
  p_user_id         UUID,
  p_total_amount    NUMERIC,    -- amount + fee, debited from balance_cdf
  p_daily_limit     NUMERIC,
  p_idempotency_key TEXT,
  p_tx_id           UUID,
  p_operator        TEXT,
  p_phone           TEXT,
  p_amount          NUMERIC,    -- payout amount the user receives
  p_fee             NUMERIC,
  p_net_amount      NUMERIC,
  p_currency        TEXT,
  p_reference       TEXT,
  p_metadata        JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet      public.wallet_users%ROWTYPE;
  v_existing    public.transactions%ROWTYPE;
  v_daily_used  NUMERIC := 0;
  v_new_balance NUMERIC;
  v_day_start   timestamptz;
BEGIN
  -- 0. Input guards — BEFORE taking any lock. The refund path credits
  --    amount + fee, so a total that does not match amount+fee would
  --    silently corrupt the balance; a non-CDF currency must never
  --    reach this CDF-only claim; negative amounts/fees are nonsense.
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: amount must be > 0';
  END IF;
  IF p_fee < 0 THEN
    RAISE EXCEPTION 'INVALID_FEE: fee must be >= 0';
  END IF;
  IF p_total_amount <> p_amount + p_fee THEN
    RAISE EXCEPTION 'INVALID_TOTAL';
  END IF;
  IF upper(p_currency) <> 'CDF' THEN
    RAISE EXCEPTION 'UNSUPPORTED_WALLET_CURRENCY';
  END IF;

  v_day_start := date_trunc('day', now()) AT TIME ZONE 'UTC';

  -- 1. Lock the wallet row — serializes concurrent withdrawals
  --    and same-key replays for this wallet.
  SELECT * INTO v_wallet
  FROM public.wallet_users
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  -- 2. Idempotency check UNDER the lock: a concurrent same-key
  --    request waits on the lock, then sees the committed claim.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.transactions
    WHERE wallet_user_id = p_user_id
      AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
      -- Same key, different payload → refuse: returning the first
      -- attempt's result would silently misreport what the caller
      -- asked for. The route maps this to HTTP 422.
      IF v_existing.amount    IS DISTINCT FROM p_amount
         OR v_existing.operator  IS DISTINCT FROM p_operator
         OR v_existing.phone     IS DISTINCT FROM p_phone
         OR v_existing.currency  IS DISTINCT FROM p_currency THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED';
      END IF;

      -- Replay — return the existing transaction untouched, whatever
      -- its status. Same shape as the first response.
      RETURN jsonb_build_object(
        'idempotent',      true,
        'claimed',         false,
        'transaction_id',  v_existing.id,
        'status',          v_existing.status,
        'amount',          v_existing.amount,
        'fee',             v_existing.fee,
        'net_amount',      v_existing.net_amount,
        'currency',        v_existing.currency
      );
    END IF;
  END IF;

  -- 3. Guards — identical to wallet_debit_with_kyc_limit.
  IF NOT v_wallet.is_active THEN
    RAISE EXCEPTION 'WALLET_SUSPENDED';
  END IF;

  -- 'pending' IS included: a claim is debited money in flight.
  -- See header comment — this keeps the M3 TOCTOU closed while
  -- the provider call runs.
  SELECT COALESCE(SUM(amount), 0) INTO v_daily_used
  FROM public.transactions
  WHERE wallet_user_id = p_user_id
    AND direction = 'payout'
    AND status IN ('pending', 'processing', 'success')
    AND created_at >= v_day_start;

  IF v_daily_used + p_total_amount > p_daily_limit THEN
    RAISE EXCEPTION 'KYC_LIMIT_EXCEEDED: daily_used %, requested %, limit %',
      v_daily_used, p_total_amount, p_daily_limit;
  END IF;

  IF v_wallet.balance_cdf < p_total_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS: balance %, required %',
      v_wallet.balance_cdf, p_total_amount;
  END IF;

  -- 4. Claim: the pending transaction row carries the key, inside
  --    the same transaction as the debit.
  INSERT INTO public.transactions (
    id, wallet_user_id, operator, direction, amount, fee, net_amount,
    currency, phone, reference, blockchain_tx_hash, status, metadata,
    idempotency_key
  ) VALUES (
    p_tx_id, p_user_id, p_operator, 'payout', p_amount, p_fee, p_net_amount,
    p_currency, p_phone, p_reference, NULL, 'pending', p_metadata,
    p_idempotency_key
  );

  -- 5. Debit — same UPDATE as wallet_debit_with_kyc_limit.
  v_new_balance := v_wallet.balance_cdf - p_total_amount;

  UPDATE public.wallet_users
  SET balance_cdf = v_new_balance,
      updated_at = now()
  WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'idempotent',         false,
    'claimed',            true,
    'transaction_id',     p_tx_id,
    'new_balance',        v_new_balance,
    'daily_used_before',  v_daily_used,
    'daily_used_after',   v_daily_used + p_total_amount,
    'daily_limit',        p_daily_limit
  );
END;
$$;

-- ── 5. Orphan-claim sweeper ─────────────────────────────────
-- ⛔ DO NOT CALL until the caller verifies Unipesa status.
-- This function refunds debited-but-undelivered claims. It must only
-- be invoked after an out-of-band check (Unipesa /status by
-- order_id = reference) proves the provider never created the payout.
-- Calling it on a tx the provider did execute produces a DOUBLE SPEND
-- (wallet refunded + payout delivered). Wire it into the
-- reconciliation worker only once that check exists; until then,
-- manual per-transaction use after verification only.
CREATE OR REPLACE FUNCTION public.wallet_withdraw_sweep_orphans(
  p_older_than_minutes INTEGER DEFAULT 15
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx     public.transactions%ROWTYPE;
  v_result JSONB;
  v_out    JSONB := '[]'::jsonb;
BEGIN
  FOR v_tx IN
    SELECT * FROM public.transactions
    WHERE direction = 'payout'
      AND wallet_user_id IS NOT NULL
      AND status = 'pending'
      AND avada_transaction_id IS NULL
      AND created_at < now() - make_interval(mins => p_older_than_minutes)
    ORDER BY created_at
  LOOP
    v_result := public.wallet_withdraw_fail_and_refund(
      v_tx.id, 'orphan_claim_sweep'
    );
    v_out := v_out || jsonb_build_object(
      'transaction_id', v_tx.id,
      'reference',      v_tx.reference,
      'result',         v_result
    );
  END LOOP;
  RETURN v_out;
END;
$$;

-- ── 6. Callback RPC — delegate wallet payout refunds ─────────
-- Replaces the inline wallet-payout refund inside
-- process_wallet_provider_callback with a call to
-- wallet_withdraw_fail_and_refund, so route-level provider failure,
-- inbound callbacks and the reconciliation worker share ONE atomic
-- transition. Everything else is carried verbatim from the
-- 20260916120000_fix_callback_regressions version (merchant ledger
-- blocks, settlement propagation, metadata merge).
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

  -- ── Wallet user credits/refunds ──────────────────────────────
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
    -- Single transition path: atomic refund + 'failed' under the tx
    -- and wallet locks. The tx row is already FOR UPDATE here —
    -- re-locking in the callee is a no-op within this transaction.
    SELECT (r->>'refunded')::numeric INTO v_refund
    FROM public.wallet_withdraw_fail_and_refund(
      v_tx.id,
      'provider_callback_failed'
    ) AS r;
  END IF;

  -- ── Merchant ledger credit on collect success ────────────────
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

  -- ── Merchant ledger re-credit on payout failure ──────────────
  -- Merchant payouts (wallet_user_id IS NULL) are re-credited here;
  -- wallet payouts are handled by wallet_withdraw_fail_and_refund.
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

  -- ── Update transaction status (merge metadata, don't overwrite)
  -- Read metadata fresh: on the wallet-payout-failed path the refund
  -- RPC has already appended refund_reason/refunded_amount, which we
  -- want preserved under merchant_metadata.
  SELECT metadata INTO v_merged_metadata
  FROM public.transactions WHERE id = v_tx.id;

  v_merged_metadata := jsonb_build_object(
    'merchant_metadata', v_merged_metadata,
    'provider_payload', COALESCE(p_payload, null)
  );

  UPDATE public.transactions
  SET status = p_new_status,
      avada_transaction_id = COALESCE(p_provider_transaction_id, avada_transaction_id),
      metadata = v_merged_metadata,
      updated_at = now()
  WHERE id = v_tx.id;

  -- ── Settlement propagation ───────────────────────────────────
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

-- ── 7. Grants ────────────────────────────────────────────────
-- SECURITY DEFINER + REVOKE is mandatory: CREATE OR REPLACE resets
-- the function ACL to default (EXECUTE to PUBLIC → anon +
-- authenticated). Matches the guard test whitelist (wallet_%,
-- process_wallet_%) in
-- supabase/tests/20260912000000_security_definer_grants_guard.sql.

REVOKE ALL ON FUNCTION public.wallet_withdraw_claim(UUID, NUMERIC, NUMERIC, TEXT, UUID, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wallet_withdraw_fail_and_refund(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wallet_withdraw_sweep_orphans(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_wallet_provider_callback(TEXT, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.wallet_withdraw_claim(UUID, NUMERIC, NUMERIC, TEXT, UUID, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.wallet_withdraw_fail_and_refund(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.wallet_withdraw_sweep_orphans(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_wallet_provider_callback(TEXT, TEXT, UUID, TEXT, TEXT, JSONB) TO service_role;
