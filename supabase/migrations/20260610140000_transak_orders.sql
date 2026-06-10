-- Transak fiat→USDT orders table
-- Tracks every Transak widget session initiated by a wallet user.
-- On ORDER_COMPLETED, if is_custody=true, usd_balance is credited automatically.

CREATE TABLE IF NOT EXISTS public.transak_orders (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID          NOT NULL REFERENCES public.wallet_users(id) ON DELETE CASCADE,
  transak_order_id TEXT          UNIQUE,                  -- filled when Transak confirms
  status           TEXT          NOT NULL DEFAULT 'PENDING',
  fiat_amount      NUMERIC(12,2) NOT NULL,
  fiat_currency    TEXT          NOT NULL DEFAULT 'USD',  -- USD | EUR
  crypto_amount    NUMERIC(18,8),                         -- USDT credited
  wallet_address   TEXT          NOT NULL,                -- BSC destination
  is_custody       BOOLEAN       NOT NULL DEFAULT true,   -- true → credit usd_balance on completion
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Idempotency index: one record per external Transak order ID
CREATE UNIQUE INDEX IF NOT EXISTS transak_orders_transak_id_idx
  ON public.transak_orders (transak_order_id)
  WHERE transak_order_id IS NOT NULL;

-- Lookup by user
CREATE INDEX IF NOT EXISTS transak_orders_user_idx
  ON public.transak_orders (user_id, created_at DESC);

COMMENT ON TABLE public.transak_orders IS
  'Transak fiat→USDT purchase sessions. Custody orders auto-credit usd_balance on completion.';
