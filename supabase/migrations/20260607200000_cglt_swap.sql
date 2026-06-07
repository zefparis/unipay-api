ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS swap_direction text,
ADD COLUMN IF NOT EXISTS usdt_amount numeric(20,8);
