-- USDT crypto withdrawal requests (via Binance)
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL,
  amount               NUMERIC     NOT NULL CHECK (amount > 0),
  network              TEXT        NOT NULL CHECK (network IN ('BSC', 'TRC20', 'ERC20')),
  destination_address  TEXT        NOT NULL,
  fee                  NUMERIC     NOT NULL DEFAULT 0,
  status               TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'validating', 'processing', 'completed', 'failed', 'cancelled')),
  binance_withdraw_id  TEXT,
  tx_hash              TEXT,
  failure_reason       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user   ON withdrawal_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);

ALTER TABLE withdrawal_requests ENABLE ROW LEVEL SECURITY;
