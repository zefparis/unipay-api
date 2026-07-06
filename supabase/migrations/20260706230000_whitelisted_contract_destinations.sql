-- ══════════════════════════════════════════════════════════════
-- Migration: whitelisted_contract_destinations
-- Allows certain smart contract addresses (e.g. exchange deposit
-- addresses) to receive withdrawals despite the isContractAddress guard.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.whitelisted_contract_destinations (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  address    text        NOT NULL UNIQUE,  -- lowercase EVM address
  label      text        NOT NULL,          -- e.g. "Binance Hot Wallet 3"
  added_by   text,                          -- admin identifier
  added_at   timestamptz NOT NULL DEFAULT now()
);

-- RLS: service_role only (admin manages via SQL or admin route)
ALTER TABLE public.whitelisted_contract_destinations
  ENABLE ROW LEVEL SECURITY;

CREATE POLICY whitelisted_contract_destinations_service_role
  ON public.whitelisted_contract_destinations
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Index for fast lookup (the withdrawal path queries by address)
CREATE INDEX IF NOT EXISTS idx_whitelisted_contract_destinations_address
  ON public.whitelisted_contract_destinations (address);

COMMENT ON TABLE public.whitelisted_contract_destinations IS
  'Exchange / custody contract addresses allowed as withdrawal destinations despite being smart contracts. Managed by admin.';

NOTIFY pgrst, 'reload schema';
