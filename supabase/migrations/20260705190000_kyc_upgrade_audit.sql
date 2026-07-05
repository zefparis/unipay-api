-- Add submission_type column to distinguish initial KYC from cognitive upgrade
ALTER TABLE kyc_submissions ADD COLUMN IF NOT EXISTS submission_type varchar(30) NOT NULL DEFAULT 'initial';

-- Allow 'failed' status for cognitive upgrade attempts that error out
ALTER TABLE kyc_submissions DROP CONSTRAINT IF EXISTS kyc_submissions_status_check;
ALTER TABLE kyc_submissions ADD CONSTRAINT kyc_submissions_status_check 
  CHECK (status IN ('pending', 'approved', 'rejected', 'failed'));
