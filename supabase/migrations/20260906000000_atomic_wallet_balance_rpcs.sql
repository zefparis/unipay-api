CREATE OR REPLACE FUNCTION public.wallet_debit_usdt(
  p_user_id UUID,
  p_amount NUMERIC
) RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  UPDATE public.wallet_users
  SET usdt_balance = usdt_balance - p_amount,
      updated_at = now()
  WHERE id = p_user_id
    AND is_active = true
    AND usdt_balance >= p_amount
  RETURNING usdt_balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_USDT';
  END IF;

  RETURN v_new_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.wallet_debit_cglt(
  p_user_id UUID,
  p_amount NUMERIC
) RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  UPDATE public.wallet_users
  SET cglt_balance = cglt_balance - p_amount,
      updated_at = now()
  WHERE id = p_user_id
    AND is_active = true
    AND cglt_balance >= p_amount
  RETURNING cglt_balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_CGLT';
  END IF;

  RETURN v_new_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.wallet_credit_cglt(
  p_user_id UUID,
  p_amount NUMERIC
) RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  UPDATE public.wallet_users
  SET cglt_balance = cglt_balance + p_amount,
      updated_at = now()
  WHERE id = p_user_id
  RETURNING cglt_balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  RETURN v_new_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.wallet_credit_cdf(
  p_user_id UUID,
  p_amount NUMERIC
) RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  UPDATE public.wallet_users
  SET balance_cdf = balance_cdf + p_amount,
      updated_at = now()
  WHERE id = p_user_id
  RETURNING balance_cdf INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  RETURN v_new_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.wallet_adjust_cdf(
  p_user_id UUID,
  p_delta NUMERIC
) RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance NUMERIC;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  UPDATE public.wallet_users
  SET balance_cdf = balance_cdf + p_delta,
      updated_at = now()
  WHERE id = p_user_id
    AND balance_cdf + p_delta >= 0
  RETURNING balance_cdf INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND_OR_INSUFFICIENT_FUNDS';
  END IF;

  RETURN v_new_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.wallet_debit_usdt(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wallet_debit_cglt(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wallet_credit_cglt(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wallet_credit_cdf(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wallet_adjust_cdf(UUID, NUMERIC) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.wallet_debit_usdt(UUID, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.wallet_debit_cglt(UUID, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.wallet_credit_cglt(UUID, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.wallet_credit_cdf(UUID, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.wallet_adjust_cdf(UUID, NUMERIC) TO service_role;

NOTIFY pgrst, 'reload schema';
