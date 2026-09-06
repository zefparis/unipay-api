-- ============================================================
-- Merchant settlement ledger + settlement requests
-- ============================================================

-- ── 1. Add settlement_phone to merchants ──────────────────────
ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS settlement_phone text;

COMMENT ON COLUMN public.merchants.settlement_phone IS
  'Mobile Money phone number for merchant settlements (may differ from contact phone).';

-- ── 2. merchant_ledger_entries ────────────────────────────────
-- Immutable append-only ledger. Each row is either a credit (money
-- collected on behalf of the merchant) or a settlement (money paid
-- out to the merchant). The running balance is the sum of credits
-- minus settlements.
CREATE TABLE IF NOT EXISTS public.merchant_ledger_entries (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   uuid          NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  transaction_id uuid         REFERENCES public.transactions(id) ON DELETE SET NULL,
  type          text          NOT NULL
                               CHECK (type IN ('credit', 'settlement')),
  amount        numeric(20,4) NOT NULL,  -- positive for credit, positive for settlement (debit)
  balance_after numeric(20,4) NOT NULL,  -- running balance after this entry
  created_at    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchant_ledger_merchant_id
  ON public.merchant_ledger_entries (merchant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_merchant_ledger_transaction_id
  ON public.merchant_ledger_entries (transaction_id);

ALTER TABLE public.merchant_ledger_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "merchant_ledger_service_role_all" ON public.merchant_ledger_entries;
CREATE POLICY "merchant_ledger_service_role_all"
  ON public.merchant_ledger_entries FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── 3. merchant_settlement_requests ───────────────────────────
-- Tracks settlement requests from merchants and their lifecycle:
--   pending_admin_review → processing → success | failed
--   pending_admin_review → rejected (admin rejects, ledger re-credited)
CREATE TABLE IF NOT EXISTS public.merchant_settlement_requests (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     uuid          NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  amount          numeric(20,4) NOT NULL CHECK (amount > 0),
  phone           text          NOT NULL,
  status          text          NOT NULL DEFAULT 'pending_admin_review'
                                 CHECK (status IN ('pending_admin_review', 'processing', 'success', 'failed', 'rejected')),
  ledger_entry_id uuid          REFERENCES public.merchant_ledger_entries(id) ON DELETE SET NULL,
  provider_ref    text,         -- avada_transaction_id after payout
  reject_reason   text,
  idempotency_key text          UNIQUE,  -- prevents double-clic double-payout
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_settlement_requests_merchant_id
  ON public.merchant_settlement_requests (merchant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_settlement_requests_status
  ON public.merchant_settlement_requests (status);

ALTER TABLE public.merchant_settlement_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "merchant_settlement_requests_service_role_all" ON public.merchant_settlement_requests;
CREATE POLICY "merchant_settlement_requests_service_role_all"
  ON public.merchant_settlement_requests FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_settlement_requests_updated_at ON public.merchant_settlement_requests;
CREATE TRIGGER trg_settlement_requests_updated_at
  BEFORE UPDATE ON public.merchant_settlement_requests
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();
