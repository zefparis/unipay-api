ALTER TABLE wallet_users 
ADD COLUMN IF NOT EXISTS blockchain_address text,
ADD COLUMN IF NOT EXISTS blockchain_private_key_encrypted text,
ADD COLUMN IF NOT EXISTS cglt_balance numeric(20,8) DEFAULT 0;

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS blockchain_tx_hash text,
ADD COLUMN IF NOT EXISTS cglt_amount numeric(20,8);
