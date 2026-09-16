-- ============================================================
-- M5 remediation: wallet_p2p — prevent fund disappearance
-- ============================================================
-- The original wallet_p2p (20260606000001_wallet_rpc.sql:25-45)
-- debits the sender (first UPDATE) then credits the receiver
-- (second UPDATE) WITHOUT checking IF NOT FOUND on the second
-- UPDATE. If the receiver is inactive (is_active = false, the
-- condition in the WHERE clause), the second UPDATE affects 0
-- rows silently — the sender is debited, nobody is credited,
-- the funds disappear.
--
-- Fix: after the second UPDATE, check IF NOT FOUND and raise an
-- exception. In PL/pgSQL, an exception in a function automatically
-- rolls back ALL changes made during the function's execution
-- (the function runs in its own transaction). So the sender's
-- debit is rolled back — no funds disappear.
--
-- The error message is explicit (RECEIVER_INACTIVE) so the caller
-- knows why the transfer failed and can inform the user.

CREATE OR REPLACE FUNCTION public.wallet_p2p(
  p_sender_id   uuid,
  p_receiver_id uuid,
  p_amount      numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Debit sender
  UPDATE wallet_users
  SET balance_cdf = balance_cdf - p_amount,
      updated_at  = now()
  WHERE id          = p_sender_id
    AND balance_cdf >= p_amount
    AND is_active   = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  -- Credit receiver
  UPDATE wallet_users
  SET balance_cdf = balance_cdf + p_amount,
      updated_at  = now()
  WHERE id        = p_receiver_id
    AND is_active = true;

  -- M5 fix: if the receiver is inactive (or doesn't exist), the
  -- credit UPDATE affects 0 rows. Without this check, the sender
  -- was debited but nobody was credited — funds disappeared.
  -- Raising an exception rolls back the entire function (including
  -- the sender debit), so no funds are lost.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEIVER_INACTIVE';
  END IF;
END;
$$;

-- The original function was not SECURITY DEFINER and had no explicit
-- search_path. The new version is SECURITY DEFINER with search_path
-- = public for consistency with the other wallet RPCs and to ensure
-- stable behavior regardless of the caller's search_path.

REVOKE ALL ON FUNCTION public.wallet_p2p(uuid, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wallet_p2p(uuid, uuid, numeric) TO service_role;
