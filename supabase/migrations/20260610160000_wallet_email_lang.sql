-- Add email and lang to wallet_users
ALTER TABLE wallet_users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE wallet_users ADD COLUMN IF NOT EXISTS lang  TEXT DEFAULT 'fr';
