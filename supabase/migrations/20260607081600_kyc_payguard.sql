ALTER TABLE wallet_users ADD COLUMN IF NOT EXISTS payguard_student_id text;
ALTER TABLE kyc_submissions ADD COLUMN IF NOT EXISTS payguard_confidence numeric;
ALTER TABLE kyc_submissions ADD COLUMN IF NOT EXISTS payguard_decision text;
