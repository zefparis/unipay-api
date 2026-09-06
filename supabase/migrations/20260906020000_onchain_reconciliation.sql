ALTER TABLE public.withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;

ALTER TABLE public.withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_status_check
  CHECK (status IN (
    'pending', 'validating', 'processing', 'pending_onchain_check',
    'completed', 'failed', 'cancelled'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_requests_tx_hash_uq
  ON public.withdrawal_requests (tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.onchain_operations (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('wcglt_mint')),
  wallet_user_id UUID NOT NULL REFERENCES public.wallet_users(id) ON DELETE RESTRICT,
  amount_debited NUMERIC NOT NULL CHECK (amount_debited > 0),
  amount_onchain NUMERIC NOT NULL CHECK (amount_onchain > 0),
  recipient TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  operator TEXT NOT NULL,
  transaction_direction TEXT NOT NULL,
  phone TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'pending_onchain_check', 'confirmed', 'refunded')),
  failure_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS onchain_operations_tx_hash_uq
  ON public.onchain_operations (tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS onchain_operations_pending_idx
  ON public.onchain_operations (status, created_at)
  WHERE status = 'pending_onchain_check';

ALTER TABLE public.onchain_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS onchain_operations_service_role_all ON public.onchain_operations;
CREATE POLICY onchain_operations_service_role_all
  ON public.onchain_operations FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.begin_usdt_onchain_withdrawal(
  p_withdrawal_id UUID,
  p_user_id UUID,
  p_amount NUMERIC,
  p_network TEXT,
  p_destination_address TEXT,
  p_fee NUMERIC
) RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_network <> 'BSC' THEN
    RAISE EXCEPTION 'INVALID_WITHDRAWAL';
  END IF;

  UPDATE public.wallet_users
  SET usdt_balance = usdt_balance - p_amount, updated_at = now()
  WHERE id = p_user_id
    AND is_active = true
    AND usdt_balance >= p_amount
  RETURNING usdt_balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_USDT';
  END IF;

  INSERT INTO public.withdrawal_requests (
    id, user_id, amount, network, destination_address, fee, status
  ) VALUES (
    p_withdrawal_id, p_user_id, p_amount, p_network, p_destination_address, p_fee, 'pending'
  );

  RETURN v_new_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_usdt_withdrawal_pending_check(
  p_withdrawal_id UUID,
  p_tx_hash TEXT,
  p_reason TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.withdrawal_requests
  SET status = 'pending_onchain_check',
      tx_hash = p_tx_hash,
      failure_reason = p_reason,
      updated_at = now()
  WHERE id = p_withdrawal_id
    AND status IN ('pending', 'processing');
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_usdt_withdrawal_onchain(
  p_withdrawal_id UUID,
  p_outcome TEXT,
  p_tx_hash TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request public.withdrawal_requests%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('confirmed', 'failed') THEN
    RAISE EXCEPTION 'INVALID_ONCHAIN_OUTCOME';
  END IF;

  SELECT * INTO v_request
  FROM public.withdrawal_requests
  WHERE id = p_withdrawal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WITHDRAWAL_NOT_FOUND';
  END IF;

  IF v_request.status IN ('completed', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('processed', false, 'already_terminal', true, 'status', v_request.status);
  END IF;

  IF p_outcome = 'confirmed' THEN
    UPDATE public.withdrawal_requests
    SET status = 'completed',
        tx_hash = COALESCE(p_tx_hash, tx_hash),
        failure_reason = NULL,
        updated_at = now()
    WHERE id = v_request.id;
    RETURN jsonb_build_object('processed', true, 'status', 'completed', 'refunded', false);
  END IF;

  UPDATE public.wallet_users
  SET usdt_balance = usdt_balance + v_request.amount, updated_at = now()
  WHERE id = v_request.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  UPDATE public.withdrawal_requests
  SET status = 'failed',
      tx_hash = COALESCE(p_tx_hash, tx_hash),
      failure_reason = COALESCE(p_reason, 'ONCHAIN_EXECUTION_FAILED'),
      updated_at = now()
  WHERE id = v_request.id;

  RETURN jsonb_build_object('processed', true, 'status', 'failed', 'refunded', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_wcglt_onchain_operation(
  p_operation_id UUID,
  p_user_id UUID,
  p_amount_debited NUMERIC,
  p_amount_onchain NUMERIC,
  p_recipient TEXT,
  p_reference TEXT,
  p_source TEXT,
  p_operator TEXT,
  p_direction TEXT,
  p_phone TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance NUMERIC;
BEGIN
  IF p_amount_debited IS NULL OR p_amount_debited <= 0 OR p_amount_onchain IS NULL OR p_amount_onchain <= 0 THEN
    RAISE EXCEPTION 'INVALID_ONCHAIN_OPERATION';
  END IF;

  UPDATE public.wallet_users
  SET cglt_balance = cglt_balance - p_amount_debited, updated_at = now()
  WHERE id = p_user_id
    AND is_active = true
    AND cglt_balance >= p_amount_debited
  RETURNING cglt_balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_CGLT';
  END IF;

  INSERT INTO public.onchain_operations (
    id, kind, wallet_user_id, amount_debited, amount_onchain, recipient,
    reference, source, operator, transaction_direction, phone, status, metadata
  ) VALUES (
    p_operation_id, 'wcglt_mint', p_user_id, p_amount_debited, p_amount_onchain, p_recipient,
    p_reference, p_source, p_operator, p_direction, p_phone, 'submitted', COALESCE(p_metadata, '{}'::jsonb)
  );

  RETURN v_new_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_wcglt_operation_pending_check(
  p_operation_id UUID,
  p_tx_hash TEXT,
  p_reason TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.onchain_operations
  SET status = 'pending_onchain_check',
      tx_hash = COALESCE(p_tx_hash, tx_hash),
      failure_reason = p_reason,
      updated_at = now()
  WHERE id = p_operation_id
    AND status = 'submitted';
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_wcglt_onchain_operation(
  p_operation_id UUID,
  p_outcome TEXT,
  p_tx_hash TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operation public.onchain_operations%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('confirmed', 'failed') THEN
    RAISE EXCEPTION 'INVALID_ONCHAIN_OUTCOME';
  END IF;

  SELECT * INTO v_operation
  FROM public.onchain_operations
  WHERE id = p_operation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ONCHAIN_OPERATION_NOT_FOUND';
  END IF;

  IF v_operation.status IN ('confirmed', 'refunded') THEN
    RETURN jsonb_build_object('processed', false, 'already_terminal', true, 'status', v_operation.status);
  END IF;

  IF p_outcome = 'failed' THEN
    UPDATE public.wallet_users
    SET cglt_balance = cglt_balance + v_operation.amount_debited, updated_at = now()
    WHERE id = v_operation.wallet_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    UPDATE public.onchain_operations
    SET status = 'refunded',
        tx_hash = COALESCE(p_tx_hash, tx_hash),
        failure_reason = COALESCE(p_reason, 'ONCHAIN_EXECUTION_FAILED'),
        updated_at = now()
    WHERE id = v_operation.id;

    RETURN jsonb_build_object('processed', true, 'status', 'refunded', 'refunded', true);
  END IF;

  IF p_tx_hash IS NULL OR p_tx_hash = '' THEN
    RAISE EXCEPTION 'TX_HASH_REQUIRED_FOR_CONFIRMATION';
  END IF;

  INSERT INTO public.transactions (
    id, wallet_user_id, operator, direction, amount, fee, net_amount,
    currency, phone, reference, cglt_amount, blockchain_tx_hash, status, metadata
  ) VALUES (
    v_operation.id, v_operation.wallet_user_id, v_operation.operator, v_operation.transaction_direction,
    v_operation.amount_debited, 0,
    CASE WHEN v_operation.transaction_direction = 'cglt_bsc_withdraw' THEN v_operation.amount_debited ELSE v_operation.amount_onchain END,
    'CGLT', v_operation.phone, v_operation.reference,
    CASE WHEN v_operation.transaction_direction = 'cglt_bsc_withdraw' THEN -v_operation.amount_debited ELSE v_operation.amount_debited END,
    p_tx_hash, 'success', v_operation.metadata || jsonb_build_object('bsc_recipient', v_operation.recipient)
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.onchain_operations
  SET status = 'confirmed',
      tx_hash = p_tx_hash,
      failure_reason = NULL,
      updated_at = now()
  WHERE id = v_operation.id;

  RETURN jsonb_build_object('processed', true, 'status', 'confirmed', 'refunded', false);
END;
$$;

REVOKE ALL ON TABLE public.onchain_operations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE public.onchain_operations TO service_role;

REVOKE ALL ON FUNCTION public.begin_usdt_onchain_withdrawal(UUID, UUID, NUMERIC, TEXT, TEXT, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_usdt_withdrawal_pending_check(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_usdt_withdrawal_onchain(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_wcglt_onchain_operation(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_wcglt_operation_pending_check(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_wcglt_onchain_operation(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.begin_usdt_onchain_withdrawal(UUID, UUID, NUMERIC, TEXT, TEXT, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_usdt_withdrawal_pending_check(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_usdt_withdrawal_onchain(UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_wcglt_onchain_operation(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_wcglt_operation_pending_check(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_wcglt_onchain_operation(UUID, TEXT, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
