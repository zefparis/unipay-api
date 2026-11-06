-- ── backfill_partner_commissions : + filtre optionnel par marchand ──
-- Permet à l'admin de recalculer les commissions pour UN seul marchand
-- rattaché (ex. après rattachement manuel via PATCH /admin/merchants/:id/referrer)
-- au lieu de scanner tous les marchands parrainés sur la plage de dates.
-- Signature étendue → DROP + CREATE (l'ancienne signature 3-args disparaît,
-- les appels existants passent par le DEFAULT NULL de p_merchant_id).

DROP FUNCTION IF EXISTS public.backfill_partner_commissions(TIMESTAMPTZ, TIMESTAMPTZ, NUMERIC);

CREATE OR REPLACE FUNCTION public.backfill_partner_commissions(
  p_date_from TIMESTAMPTZ,
  p_date_to TIMESTAMPTZ,
  p_provider_fee_rate NUMERIC DEFAULT NULL,
  p_merchant_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx_id UUID;
  v_result JSONB;
  v_credited INTEGER := 0;
  v_skipped INTEGER := 0;
  v_no_margin INTEGER := 0;
  v_none INTEGER := 0;
  v_errors INTEGER := 0;
BEGIN
  -- Same rule as credit_partner_commission: NULL provider fee rate
  -- means the margin cap is unknown — refuse the whole batch.
  IF p_provider_fee_rate IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'provider_fee_rate missing');
  END IF;

  FOR v_tx_id IN
    SELECT t.id
    FROM public.transactions t
    JOIN public.merchants m ON m.id = t.merchant_id
    WHERE t.status = 'success'
      AND t.merchant_id IS NOT NULL
      AND t.wallet_user_id IS NULL
      AND t.settlement_request_id IS NULL
      AND t.fee > 0
      AND m.referred_by_partner_id IS NOT NULL
      AND t.created_at >= p_date_from
      AND t.created_at < p_date_to
      AND (p_merchant_id IS NULL OR t.merchant_id = p_merchant_id)
    ORDER BY t.created_at
  LOOP
    BEGIN
      v_result := public.credit_partner_commission(v_tx_id, p_provider_fee_rate);
      CASE v_result->>'status'
        WHEN 'credited'          THEN v_credited := v_credited + 1;
        WHEN 'skipped_duplicate' THEN v_skipped := v_skipped + 1;
        WHEN 'no_margin'         THEN v_no_margin := v_no_margin + 1;
        ELSE                          v_none := v_none + 1;
      END CASE;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'credited', v_credited,
    'skipped_duplicate', v_skipped,
    'no_margin', v_no_margin,
    'not_eligible', v_none,
    'errors', v_errors
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_partner_commissions(TIMESTAMPTZ, TIMESTAMPTZ, NUMERIC, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_partner_commissions(TIMESTAMPTZ, TIMESTAMPTZ, NUMERIC, UUID) TO service_role;
