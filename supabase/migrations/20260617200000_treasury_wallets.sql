-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: treasury_wallets
-- Purpose : Register treasury receiving wallets for on-chain balance monitoring.
--           Read-only visibility — no private keys, no signing, no withdrawals.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.treasury_wallets (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  label           TEXT        NOT NULL,
  asset           TEXT        NOT NULL CHECK (asset IN ('USDC', 'USDT')),
  network         TEXT        NOT NULL CHECK (network IN ('BSC', 'ERC20', 'TRC20', 'Polygon', 'Base', 'Arbitrum')),
  address         TEXT        NOT NULL,
  token_contract  TEXT        NOT NULL,
  decimals        INTEGER     NOT NULL DEFAULT 18,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tw_asset_network
  ON public.treasury_wallets (asset, network);

CREATE INDEX IF NOT EXISTS idx_tw_address
  ON public.treasury_wallets (lower(address));

ALTER TABLE public.treasury_wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.treasury_wallets
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.treasury_wallets IS
  'Treasury receiving wallet registry for on-chain balance visibility.
   Read-only: no private keys stored. No wallet balance credited.';

-- ── Known BSC token contracts (informational seed) ────────────────────────
-- Admin can insert wallets via the admin API — this is just a reference comment.
-- USDC BSC : 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d (18 decimals)
-- USDT BSC : 0x55d398326f99059fF775485246999027B3197955 (18 decimals)
