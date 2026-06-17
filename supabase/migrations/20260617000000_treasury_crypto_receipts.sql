-- ============================================================
-- Migration: treasury_crypto_receipts
-- Version   : 20260617000000
-- Purpose   : Record corporate treasury crypto payments
--             (marketing invoices, etc.).
--             Completely independent of wallet_users balances.
--             Does NOT credit any user wallet.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.treasury_crypto_receipts (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id         TEXT,
  invoice_reference  TEXT,
  payer_name         TEXT,
  payer_email        TEXT,
  asset              TEXT          NOT NULL
                                     CHECK (asset IN ('USDC', 'USDT')),
  network            TEXT          NOT NULL
                                     CHECK (network IN ('BSC', 'ERC20', 'TRC20')),
  amount             NUMERIC(24,6) NOT NULL
                                     CHECK (amount > 0),
  wallet_address     TEXT,
  tx_hash            TEXT          NOT NULL,
  binance_account    TEXT,
  status             TEXT          NOT NULL DEFAULT 'received'
                                     CHECK (status IN ('pending', 'received', 'confirmed', 'converted', 'rejected')),
  received_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  converted_to_asset TEXT,
  conversion_amount  NUMERIC(24,6),
  conversion_tx_id   TEXT,
  notes              TEXT,
  created_by         TEXT,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT treasury_crypto_receipts_tx_hash_unique UNIQUE (tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_tcr_asset
  ON public.treasury_crypto_receipts (asset);

CREATE INDEX IF NOT EXISTS idx_tcr_network
  ON public.treasury_crypto_receipts (network);

CREATE INDEX IF NOT EXISTS idx_tcr_status
  ON public.treasury_crypto_receipts (status);

CREATE INDEX IF NOT EXISTS idx_tcr_invoice_id
  ON public.treasury_crypto_receipts (invoice_id)
  WHERE invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tcr_created_at
  ON public.treasury_crypto_receipts (created_at DESC);

-- updated_at trigger (reuses the function already defined in the schema)
DROP TRIGGER IF EXISTS treasury_crypto_receipts_updated_at
  ON public.treasury_crypto_receipts;

CREATE TRIGGER treasury_crypto_receipts_updated_at
  BEFORE UPDATE ON public.treasury_crypto_receipts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS — only the service role (API server) may read/write
ALTER TABLE public.treasury_crypto_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.treasury_crypto_receipts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.treasury_crypto_receipts IS
  'Corporate treasury crypto receipts (marketing invoices, etc.).
   Completely independent of wallet_users — no balance is credited here.';
