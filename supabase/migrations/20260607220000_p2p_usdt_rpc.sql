CREATE OR REPLACE FUNCTION wallet_p2p_usdt(
  p_sender_id uuid,
  p_receiver_id uuid,
  p_amount numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wallet_users
  SET usdt_balance = usdt_balance - p_amount,
      updated_at = now()
  WHERE id = p_sender_id
    AND usdt_balance >= p_amount
    AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_USDT';
  END IF;
  UPDATE wallet_users
  SET usdt_balance = usdt_balance + p_amount,
      updated_at = now()
  WHERE id = p_receiver_id
    AND is_active = true;
END;
$$;
