DO $$
DECLARE
  v_duplicates TEXT;
BEGIN
  SELECT string_agg(format('%s (%s)', value, duplicate_count), ', ' ORDER BY value)
  INTO v_duplicates
  FROM (
    SELECT reference AS value, count(*) AS duplicate_count
    FROM public.transactions
    WHERE reference IS NOT NULL
      AND direction NOT IN ('p2p', 'p2p_usdt')
    GROUP BY reference
    HAVING count(*) > 1
    ORDER BY reference
    LIMIT 20
  ) duplicates;

  IF v_duplicates IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Cannot add transactions reference uniqueness: duplicate non-P2P references exist',
      DETAIL = v_duplicates,
      HINT = 'Reconcile or rename the listed references, then rerun this migration.';
  END IF;

  SELECT string_agg(format('%s (%s)', value, duplicate_count), ', ' ORDER BY value)
  INTO v_duplicates
  FROM (
    SELECT avada_transaction_id AS value, count(*) AS duplicate_count
    FROM public.transactions
    WHERE avada_transaction_id IS NOT NULL
    GROUP BY avada_transaction_id
    HAVING count(*) > 1
    ORDER BY avada_transaction_id
    LIMIT 20
  ) duplicates;

  IF v_duplicates IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Cannot add Avada transaction uniqueness: duplicate provider IDs exist',
      DETAIL = v_duplicates,
      HINT = 'Reconcile the listed Avada transaction IDs, then rerun this migration.';
  END IF;

  SELECT string_agg(format('%s (%s)', value, duplicate_count), ', ' ORDER BY value)
  INTO v_duplicates
  FROM (
    SELECT blockchain_tx_hash AS value, count(*) AS duplicate_count
    FROM public.transactions
    WHERE blockchain_tx_hash IS NOT NULL
    GROUP BY blockchain_tx_hash
    HAVING count(*) > 1
    ORDER BY blockchain_tx_hash
    LIMIT 20
  ) duplicates;

  IF v_duplicates IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Cannot add blockchain transaction uniqueness: duplicate transaction hashes exist',
      DETAIL = v_duplicates,
      HINT = 'Reconcile the listed blockchain hashes, then rerun this migration.';
  END IF;

  SELECT string_agg(format('%s (%s)', value, duplicate_count), ', ' ORDER BY value)
  INTO v_duplicates
  FROM (
    SELECT transak_order_id AS value, count(*) AS duplicate_count
    FROM public.transak_orders
    WHERE transak_order_id IS NOT NULL
    GROUP BY transak_order_id
    HAVING count(*) > 1
    ORDER BY transak_order_id
    LIMIT 20
  ) duplicates;

  IF v_duplicates IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Cannot enforce Transak order uniqueness: duplicate provider order IDs exist',
      DETAIL = v_duplicates,
      HINT = 'Reconcile the listed Transak order IDs, then rerun this migration.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_reference_provider_uq
  ON public.transactions (reference)
  WHERE reference IS NOT NULL
    AND direction NOT IN ('p2p', 'p2p_usdt');

CREATE UNIQUE INDEX IF NOT EXISTS transactions_avada_transaction_id_uq
  ON public.transactions (avada_transaction_id)
  WHERE avada_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_blockchain_tx_hash_uq
  ON public.transactions (blockchain_tx_hash)
  WHERE blockchain_tx_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS transak_orders_provider_id_uq
  ON public.transak_orders (transak_order_id)
  WHERE transak_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.provider_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  transaction_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_webhook_events_provider_event_uq UNIQUE (provider, provider_event_id)
);

ALTER TABLE public.provider_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS provider_webhook_events_service_role_select ON public.provider_webhook_events;
CREATE POLICY provider_webhook_events_service_role_select
  ON public.provider_webhook_events FOR SELECT TO service_role USING (true);

DROP POLICY IF EXISTS provider_webhook_events_service_role_insert ON public.provider_webhook_events;
CREATE POLICY provider_webhook_events_service_role_insert
  ON public.provider_webhook_events FOR INSERT TO service_role WITH CHECK (true);

INSERT INTO public.provider_webhook_events (provider, provider_event_id, transaction_id, payload)
SELECT
  'stripe',
  reference,
  id,
  jsonb_build_object('backfilled', true)
FROM public.transactions
WHERE reference IS NOT NULL
  AND metadata->>'source' = 'stripe_webhook'
ON CONFLICT (provider, provider_event_id) DO NOTHING;

INSERT INTO public.provider_webhook_events (provider, provider_event_id, payload)
SELECT
  'transak',
  COALESCE(transak_order_id, id::text),
  jsonb_build_object('backfilled', true, 'partner_order_id', id)
FROM public.transak_orders
WHERE status = 'COMPLETED'
ON CONFLICT (provider, provider_event_id) DO NOTHING;

INSERT INTO public.provider_webhook_events (provider, provider_event_id, transaction_id, payload)
SELECT
  'bridge_incoming',
  blockchain_tx_hash,
  id,
  jsonb_build_object('backfilled', true)
FROM public.transactions
WHERE blockchain_tx_hash IS NOT NULL
  AND metadata->>'source' = 'wcglt_incoming'
ON CONFLICT (provider, provider_event_id) DO NOTHING;

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

  UPDATE public.transactions
  SET status = p_new_status,
      avada_transaction_id = COALESCE(p_provider_transaction_id, avada_transaction_id),
      metadata = COALESCE(p_payload, '{}'::jsonb),
      updated_at = now()
  WHERE id = v_tx.id;

  RETURN jsonb_build_object(
    'processed', true,
    'duplicate', false,
    'credited', v_credit,
    'refunded', v_refund,
    'status', p_new_status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_stripe_wallet_deposit(
  p_payment_intent_id TEXT,
  p_wallet_user_id UUID,
  p_amount NUMERIC,
  p_payload JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed UUID;
  v_transaction_id UUID := gen_random_uuid();
BEGIN
  IF p_payment_intent_id IS NULL OR p_payment_intent_id = '' OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_STRIPE_DEPOSIT';
  END IF;

  INSERT INTO public.provider_webhook_events (provider, provider_event_id, transaction_id, payload)
  VALUES ('stripe', p_payment_intent_id, v_transaction_id, COALESCE(p_payload, '{}'::jsonb))
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING id INTO v_claimed;

  IF v_claimed IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'duplicate', true);
  END IF;

  UPDATE public.wallet_users
  SET usd_balance = usd_balance + p_amount, updated_at = now()
  WHERE id = p_wallet_user_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  INSERT INTO public.transactions (
    id, wallet_user_id, operator, direction, amount, fee, net_amount,
    currency, phone, reference, status, metadata
  )
  SELECT
    v_transaction_id, p_wallet_user_id, 'stripe', 'deposit', p_amount, 0, p_amount,
    'USD', phone, p_payment_intent_id, 'success',
    jsonb_build_object('stripe_payment_intent', p_payment_intent_id, 'source', 'stripe_webhook') || COALESCE(p_payload, '{}'::jsonb)
  FROM public.wallet_users
  WHERE id = p_wallet_user_id;

  RETURN jsonb_build_object('processed', true, 'duplicate', false, 'transaction_id', v_transaction_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_transak_webhook(
  p_provider_order_id TEXT,
  p_partner_order_id UUID,
  p_new_status TEXT,
  p_crypto_amount NUMERIC,
  p_payload JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed UUID;
  v_order public.transak_orders%ROWTYPE;
  v_transaction_id UUID := gen_random_uuid();
  v_credited NUMERIC := 0;
BEGIN
  IF p_provider_order_id IS NULL OR p_provider_order_id = '' THEN
    RAISE EXCEPTION 'INVALID_TRANSAK_ORDER_ID';
  END IF;

  INSERT INTO public.provider_webhook_events (provider, provider_event_id, payload)
  VALUES ('transak', p_provider_order_id, COALESCE(p_payload, '{}'::jsonb))
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING id INTO v_claimed;

  IF v_claimed IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'duplicate', true);
  END IF;

  SELECT * INTO v_order
  FROM public.transak_orders
  WHERE id = p_partner_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('processed', false, 'unknown_order', true);
  END IF;

  UPDATE public.transak_orders
  SET status = p_new_status,
      transak_order_id = p_provider_order_id,
      crypto_amount = p_crypto_amount,
      updated_at = now()
  WHERE id = v_order.id;

  IF p_new_status = 'COMPLETED' AND v_order.status <> 'COMPLETED' AND v_order.is_custody THEN
    IF p_crypto_amount IS NULL OR p_crypto_amount <= 0 THEN
      RAISE EXCEPTION 'INVALID_TRANSAK_CREDIT_AMOUNT';
    END IF;

    UPDATE public.wallet_users
    SET usd_balance = usd_balance + p_crypto_amount, updated_at = now()
    WHERE id = v_order.user_id AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    INSERT INTO public.transactions (
      id, wallet_user_id, operator, direction, amount, fee, net_amount,
      currency, phone, reference, status, metadata
    )
    SELECT
      v_transaction_id, v_order.user_id, 'transak', 'deposit', p_crypto_amount, 0, p_crypto_amount,
      'USD', phone, p_provider_order_id, 'success',
      jsonb_build_object('transak_order_id', p_provider_order_id, 'partner_order_id', p_partner_order_id, 'source', 'transak_webhook') || COALESCE(p_payload, '{}'::jsonb)
    FROM public.wallet_users
    WHERE id = v_order.user_id;

    v_credited := p_crypto_amount;
  END IF;

  RETURN jsonb_build_object(
    'processed', true,
    'duplicate', false,
    'credited', v_credited,
    'user_id', v_order.user_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_bsc_deposit(
  p_user_id UUID,
  p_tx_hash TEXT,
  p_token_symbol TEXT,
  p_token_contract TEXT,
  p_amount_raw TEXT,
  p_amount_usd NUMERIC,
  p_from_address TEXT,
  p_to_address TEXT,
  p_block_number BIGINT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deposit_id UUID;
BEGIN
  IF p_tx_hash IS NULL OR p_tx_hash = '' OR p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RAISE EXCEPTION 'INVALID_BSC_DEPOSIT';
  END IF;

  INSERT INTO public.crypto_deposits (
    user_id, tx_hash, token_symbol, token_contract, amount_raw, amount_usd,
    from_address, to_address, block_number, status
  ) VALUES (
    p_user_id, p_tx_hash, p_token_symbol, p_token_contract, p_amount_raw, p_amount_usd,
    p_from_address, p_to_address, p_block_number, 'CONFIRMED'
  )
  ON CONFLICT (tx_hash) DO NOTHING
  RETURNING id INTO v_deposit_id;

  IF v_deposit_id IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'duplicate', true);
  END IF;

  UPDATE public.wallet_users
  SET usdt_balance = usdt_balance + p_amount_usd, updated_at = now()
  WHERE id = p_user_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  RETURN jsonb_build_object('processed', true, 'duplicate', false, 'deposit_id', v_deposit_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_bridge_incoming_credit(
  p_transaction_id UUID,
  p_user_id UUID,
  p_phone TEXT,
  p_cglt_amount NUMERIC,
  p_tx_hash TEXT,
  p_bsc_address TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed UUID;
  v_new_balance NUMERIC;
BEGIN
  IF p_tx_hash IS NULL OR p_tx_hash = '' OR p_cglt_amount IS NULL OR p_cglt_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_BRIDGE_CREDIT';
  END IF;

  INSERT INTO public.provider_webhook_events (provider, provider_event_id, transaction_id, payload)
  VALUES (
    'bridge_incoming', p_tx_hash, p_transaction_id,
    jsonb_build_object('bsc_address', p_bsc_address, 'cglt_amount', p_cglt_amount)
  )
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING id INTO v_claimed;

  IF v_claimed IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'duplicate', true);
  END IF;

  INSERT INTO public.transactions (
    id, wallet_user_id, operator, direction, amount, fee, net_amount,
    currency, phone, reference, blockchain_tx_hash, cglt_amount, status, metadata
  ) VALUES (
    p_transaction_id, p_user_id, 'cglt', 'collect', p_cglt_amount, 0, p_cglt_amount,
    'CGLT', p_phone, 'WCGLT-IN-' || upper(substr(p_tx_hash, 1, 8)), p_tx_hash,
    p_cglt_amount, 'success', jsonb_build_object('source', 'wcglt_incoming', 'bsc_address', p_bsc_address)
  );

  UPDATE public.wallet_users
  SET cglt_balance = cglt_balance + p_cglt_amount, updated_at = now()
  WHERE id = p_user_id
  RETURNING cglt_balance INTO v_new_balance;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  RETURN jsonb_build_object('processed', true, 'duplicate', false, 'new_balance', v_new_balance);
END;
$$;

REVOKE ALL ON TABLE public.provider_webhook_events FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE public.provider_webhook_events TO service_role;

REVOKE ALL ON FUNCTION public.process_wallet_provider_callback(TEXT, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_stripe_wallet_deposit(TEXT, UUID, NUMERIC, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_transak_webhook(TEXT, UUID, TEXT, NUMERIC, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_bsc_deposit(UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_bridge_incoming_credit(UUID, UUID, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.process_wallet_provider_callback(TEXT, TEXT, UUID, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_stripe_wallet_deposit(TEXT, UUID, NUMERIC, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_transak_webhook(TEXT, UUID, TEXT, NUMERIC, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_bsc_deposit(UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_bridge_incoming_credit(UUID, UUID, TEXT, NUMERIC, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
