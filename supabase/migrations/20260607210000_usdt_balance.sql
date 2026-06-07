ALTER TABLE wallet_users 
ADD COLUMN IF NOT EXISTS usdt_balance numeric(20,8) DEFAULT 0;
