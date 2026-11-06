-- ============================================================
-- initiate_merchant_payout — insert transaction + ledger debit atomique
-- ============================================================
-- Bug corrigé : /payment/initiate appelait debit_merchant_for_payout
-- AVANT d'insérer la ligne transactions, ce qui violait la FK
-- merchant_ledger_entries_transaction_id_fkey (23503) à chaque
-- payout live depuis la migration payout_guard (2026-09-22).
--
-- Cette RPC fait les DEUX écritures dans une seule transaction SQL :
--   1. mêmes contrôles que debit_merchant_for_payout (devise, montant,
--      verrou merchant FOR UPDATE, KYC/grace, solde suffisant)
--   2. INSERT transactions (status 'pending', direction 'payout')
--   3. INSERT merchant_ledger_entries (type 'payout')
-- Toute exception annule l'ensemble — plus jamais de débit orphelin
-- ni de ligne transactions sans débit.
--
-- Le re-crédit en cas d'échec provider reste géré par
-- recredit_merchant_payout (la transaction existe désormais, donc
-- le chemin de compensation fonctionne).
CREATE OR REPLACE FUNCTION public.initiate_merchant_payout(
  p_merchant_id    UUID,
  p_transaction_id UUID,
  p_operator       TEXT,
  p_phone          TEXT,
  p_amount         NUMERIC,
  p_fee            NUMERIC,
  p_net_amount     NUMERIC,
  p_currency       TEXT,
  p_reference      TEXT,
  p_metadata       JSONB DEFAULT '{}'::jsonb
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

  -- KYC / grace check (même règle que debit_merchant_for_payout)
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

  -- 1. Transaction row first (la FK ledger l'exige)
  INSERT INTO public.transactions (
    id, merchant_id, operator, direction, amount, fee, net_amount,
    currency, phone, reference, status, metadata
  ) VALUES (
    p_transaction_id, p_merchant_id, p_operator, 'payout', p_amount,
    COALESCE(p_fee, 0), COALESCE(p_net_amount, p_amount), v_currency,
    p_phone, p_reference, 'pending', COALESCE(p_metadata, '{}'::jsonb)
  );

  -- 2. Ledger debit — atomique avec l'insert ci-dessus
  v_new_balance := v_balance - p_amount;

  INSERT INTO public.merchant_ledger_entries (
    merchant_id, transaction_id, type, amount, balance_after, currency
  ) VALUES (
    p_merchant_id, p_transaction_id, 'payout', p_amount, v_new_balance, v_currency
  );

  RETURN jsonb_build_object(
    'initiated', true,
    'transaction_id', p_transaction_id,
    'amount', p_amount,
    'currency', v_currency,
    'balance_after', v_new_balance
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.initiate_merchant_payout TO service_role;
