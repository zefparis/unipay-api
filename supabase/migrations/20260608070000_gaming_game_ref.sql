ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS game_ref text;
