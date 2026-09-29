-- ══════════════════════════════════════════════════════════════
-- TEST: wallet withdraw idempotency + atomic refund
-- Migration under test: 20260929000000_wallet_withdraw_idempotency.sql
--
-- ⚠️ RUN ON A TEST/STAGING DATABASE ONLY — it writes to
-- wallet_users and transactions (with cleanup at the end).
--
--   psql "$TEST_DATABASE_URL" -f supabase/tests/20260929000001_wallet_withdraw_idempotency.test.sql
--
-- Proves:
--   (a) two same-key claims → one row, one debit
--   (a')same key + different payload → IDEMPOTENCY_KEY_REUSED
--   (a'')replay after failure → same tx returned, no re-debit
--   (b) insufficient balance → exception, nothing inserted/debited
--   (c) double fail_and_refund → single credit
--   (d) input guards → INVALID_TOTAL / UNSUPPORTED_WALLET_CURRENCY /
--       INVALID_AMOUNT: nothing inserted, nothing debited
--
-- True two-session concurrency (the FOR UPDATE serialization path)
-- is proven by running the same claim from two shells in parallel:
--   psql "$TEST_DATABASE_URL" -c "SELECT wallet_withdraw_claim(...)" &
--   psql "$TEST_DATABASE_URL" -c "SELECT wallet_withdraw_claim(...)" &
--   wait   → exactly one prints claimed=true, the other idempotent=true,
--            and balance decreases once.
-- ══════════════════════════════════════════════════════════════

\set ON_ERROR_STOP off

DO $$
DECLARE
  w1 UUID := '11111111-1111-1111-1111-1111111111e1';
  w2 UUID := '22222222-2222-2222-2222-2222222222e2';
  r   JSONB;
  bal NUMERIC;
  cnt INTEGER;
  raised BOOLEAN;
BEGIN
  -- ── Fixture ──────────────────────────────────────────────
  INSERT INTO public.wallet_users (id, phone, pin_hash, kyc_level, balance_cdf, is_active)
  VALUES (w1, 'TESTIDEM0001', 'test', 1, 1000, true),
         (w2, 'TESTIDEM0002', 'test', 1, 50,   true);

  -- ── (a) first claim: debits once ─────────────────────────
  r := public.wallet_withdraw_claim(
    w1, 105, 1000000, 'idem-key-A',
    'aaaaaaaa-0000-0000-0000-0000000000a1',
    'airtel', '+243997174834', 100, 5, 100, 'CDF', 'WW-TESTA001', '{}'::jsonb);
  ASSERT (r->>'claimed')::boolean = true, 'a: first claim must claim';
  ASSERT (r->>'idempotent')::boolean = false, 'a: first claim not idempotent';

  SELECT balance_cdf INTO bal FROM public.wallet_users WHERE id = w1;
  ASSERT bal = 895, 'a: balance must be 1000-105=895, got ' || bal;

  -- ── (a) second call, same key, same payload → replay ──────
  r := public.wallet_withdraw_claim(
    w1, 105, 1000000, 'idem-key-A',
    'aaaaaaaa-0000-0000-0000-0000000000a2',  -- different tx id
    'airtel', '+243997174834', 100, 5, 100, 'CDF', 'WW-TESTA002', '{}'::jsonb);
  ASSERT (r->>'idempotent')::boolean = true, 'a: replay must be idempotent';
  ASSERT (r->>'claimed')::boolean = false, 'a: replay must not claim';
  ASSERT r->>'transaction_id' = 'aaaaaaaa-0000-0000-0000-0000000000a1',
    'a: replay must return the ORIGINAL transaction id';

  SELECT balance_cdf INTO bal FROM public.wallet_users WHERE id = w1;
  ASSERT bal = 895, 'a: balance must stay 895 after replay, got ' || bal;
  SELECT COUNT(*) INTO cnt FROM public.transactions WHERE idempotency_key = 'idem-key-A';
  ASSERT cnt = 1, 'a: exactly one row for the key, got ' || cnt;

  -- ── (a') same key, different amount → 422-mapped exception ──
  raised := false;
  BEGIN
    PERFORM public.wallet_withdraw_claim(
      w1, 210, 1000000, 'idem-key-A',
      'aaaaaaaa-0000-0000-0000-0000000000a3',
      'airtel', '+243997174834', 200, 10, 200, 'CDF', 'WW-TESTA003', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    raised := position('IDEMPOTENCY_KEY_REUSED' in SQLERRM) > 0;
  END;
  ASSERT raised, 'a'': payload mismatch must raise IDEMPOTENCY_KEY_REUSED';

  SELECT balance_cdf INTO bal FROM public.wallet_users WHERE id = w1;
  ASSERT bal = 895, 'a'': balance unchanged on key reuse, got ' || bal;

  -- ── (b) insufficient balance → nothing happens ────────────
  raised := false;
  BEGIN
    PERFORM public.wallet_withdraw_claim(
      w2, 105, 1000000, 'idem-key-B',
      'bbbbbbbb-0000-0000-0000-0000000000b1',
      'airtel', '+243997174834', 100, 5, 100, 'CDF', 'WW-TESTB001', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    raised := position('INSUFFICIENT_FUNDS' in SQLERRM) > 0;
  END;
  ASSERT raised, 'b: must raise INSUFFICIENT_FUNDS';

  SELECT balance_cdf INTO bal FROM public.wallet_users WHERE id = w2;
  ASSERT bal = 50, 'b: balance untouched, got ' || bal;
  SELECT COUNT(*) INTO cnt FROM public.transactions WHERE idempotency_key = 'idem-key-B';
  ASSERT cnt = 0, 'b: no row inserted on failure, got ' || cnt;

  -- ── (c) double refund → single credit ────────────────────
  r := public.wallet_withdraw_fail_and_refund(
    'aaaaaaaa-0000-0000-0000-0000000000a1', 'test_provider_fail');
  ASSERT (r->>'refunded')::numeric = 105, 'c: first refund = 105, got ' || (r->>'refunded');
  ASSERT (r->>'already_terminal')::boolean = false, 'c: first call not terminal';

  SELECT balance_cdf INTO bal FROM public.wallet_users WHERE id = w1;
  ASSERT bal = 1000, 'c: balance restored to 1000, got ' || bal;

  r := public.wallet_withdraw_fail_and_refund(
    'aaaaaaaa-0000-0000-0000-0000000000a1', 'test_provider_fail_again');
  ASSERT (r->>'refunded')::numeric = 0, 'c: second call refunds 0, got ' || (r->>'refunded');
  ASSERT (r->>'already_terminal')::boolean = true, 'c: second call is already_terminal';

  SELECT balance_cdf INTO bal FROM public.wallet_users WHERE id = w1;
  ASSERT bal = 1000, 'c: balance still 1000 — no double credit';

  -- ── (a'') replay AFTER failure → same tx, no re-debit ─────
  r := public.wallet_withdraw_claim(
    w1, 105, 1000000, 'idem-key-A',
    'aaaaaaaa-0000-0000-0000-0000000000a4',
    'airtel', '+243997174834', 100, 5, 100, 'CDF', 'WW-TESTA004', '{}'::jsonb);
  ASSERT (r->>'idempotent')::boolean = true, 'a'': post-fail replay is idempotent';
  ASSERT r->>'status' = 'failed', 'a'': replay returns failed status';
  SELECT balance_cdf INTO bal FROM public.wallet_users WHERE id = w1;
  ASSERT bal = 1000, 'a'': no re-debit after refund';

  -- ── (d) input guards — nothing inserted, nothing debited ──
  -- (d1) total <> amount + fee → INVALID_TOTAL
  raised := false;
  BEGIN
    PERFORM public.wallet_withdraw_claim(
      w1, 999, 1000000, 'idem-key-D1',
      'dddddddd-0000-0000-0000-0000000000d1',
      'airtel', '+243997174834', 100, 5, 100, 'CDF', 'WW-TESTD001', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    raised := position('INVALID_TOTAL' in SQLERRM) > 0;
  END;
  ASSERT raised, 'd1: inconsistent total must raise INVALID_TOTAL';

  -- (d2) currency <> CDF → UNSUPPORTED_WALLET_CURRENCY
  raised := false;
  BEGIN
    PERFORM public.wallet_withdraw_claim(
      w1, 105, 1000000, 'idem-key-D2',
      'dddddddd-0000-0000-0000-0000000000d2',
      'airtel', '+243997174834', 100, 5, 100, 'USD', 'WW-TESTD002', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    raised := position('UNSUPPORTED_WALLET_CURRENCY' in SQLERRM) > 0;
  END;
  ASSERT raised, 'd2: USD must raise UNSUPPORTED_WALLET_CURRENCY';

  -- (d3) negative amount → INVALID_AMOUNT
  raised := false;
  BEGIN
    PERFORM public.wallet_withdraw_claim(
      w1, 0, 1000000, 'idem-key-D3',
      'dddddddd-0000-0000-0000-0000000000d3',
      'airtel', '+243997174834', -100, 100, -100, 'CDF', 'WW-TESTD003', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    raised := position('INVALID_AMOUNT' in SQLERRM) > 0;
  END;
  ASSERT raised, 'd3: negative amount must raise INVALID_AMOUNT';

  -- (d4) negative fee → INVALID_FEE
  raised := false;
  BEGIN
    PERFORM public.wallet_withdraw_claim(
      w1, 95, 1000000, 'idem-key-D4',
      'dddddddd-0000-0000-0000-0000000000d4',
      'airtel', '+243997174834', 100, -5, 100, 'CDF', 'WW-TESTD004', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    raised := position('INVALID_FEE' in SQLERRM) > 0;
  END;
  ASSERT raised, 'd4: negative fee must raise INVALID_FEE';

  -- Guards ran before any lock/insert: balance and table untouched.
  SELECT balance_cdf INTO bal FROM public.wallet_users WHERE id = w1;
  ASSERT bal = 1000, 'd: balance untouched by rejected claims, got ' || bal;
  SELECT COUNT(*) INTO cnt FROM public.transactions WHERE idempotency_key LIKE 'idem-key-D%';
  ASSERT cnt = 0, 'd: no row inserted by rejected claims, got ' || cnt;

  RAISE NOTICE 'ALL TESTS PASSED';

  -- ── Cleanup ───────────────────────────────────────────────
  DELETE FROM public.transactions WHERE idempotency_key LIKE 'idem-key-%';
  DELETE FROM public.wallet_users WHERE id IN (w1, w2);
END $$;
