/* ── 1. User deposit addresses ──────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS public.user_deposit_addresses (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES public.wallet_users(id) ON DELETE CASCADE,
  bsc_address TEXT        NOT NULL,
  hd_index    INTEGER     NOT NULL,             -- m/44'/60'/0'/0/<hd_index>
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_deposit_addresses_user_unique  UNIQUE (user_id),
  CONSTRAINT user_deposit_addresses_addr_unique  UNIQUE (bsc_address)
);

CREATE INDEX IF NOT EXISTS user_deposit_addresses_bsc_idx
  ON public.user_deposit_addresses (bsc_address);

COMMENT ON TABLE public.user_deposit_addresses IS
  'One BSC address per wallet user, derived from UniPay HD wallet.';

/* ── 2. Crypto deposit records ──────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS public.crypto_deposits (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID          NOT NULL REFERENCES public.wallet_users(id),
  tx_hash          TEXT          NOT NULL,      -- idempotence key
  token_symbol     TEXT          NOT NULL,      -- 'USDT' | 'wCGLT'
  token_contract   TEXT          NOT NULL,
  amount_raw       TEXT          NOT NULL,      -- on-chain value (integer string)
  amount_usd       NUMERIC(18,6),               -- converted to USD
  from_address     TEXT,
  to_address       TEXT,
  block_number     BIGINT,
  status           TEXT          NOT NULL DEFAULT 'CONFIRMED',
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS crypto_deposits_tx_hash_idx
  ON public.crypto_deposits (tx_hash);

CREATE INDEX IF NOT EXISTS crypto_deposits_user_idx
  ON public.crypto_deposits (user_id, created_at DESC);

COMMENT ON TABLE public.crypto_deposits IS
  'Inbound BEP-20 token deposits confirmed on BSC. tx_hash ensures idempotence.';

/* ── 3. System config / cron state ─────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS public.system_config (
  key        TEXT        PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.system_config (key, value) VALUES
  ('last_bsc_block_usdt',  '0'),
  ('last_bsc_block_wcglt', '0')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE public.system_config IS
  'Key/value store for operational state (last processed BSC block per token, etc.)';
