-- Coinbase CDP wallet address for each UniPay wallet user.
-- Populated asynchronously after registration via the CDP EVM Server Account API.
ALTER TABLE public.wallet_users
  ADD COLUMN IF NOT EXISTS cdp_wallet_address text;

CREATE INDEX IF NOT EXISTS wallet_users_cdp_wallet_address_idx
  ON public.wallet_users (cdp_wallet_address)
  WHERE cdp_wallet_address IS NOT NULL;
