-- KYC submissions table for wallet users
CREATE TABLE kyc_submissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_user_id   uuid REFERENCES wallet_users(id) NOT NULL,
  status           varchar(20)   NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  doc_type         varchar(30),                                -- national_id | passport | driving_license
  doc_front_url    text,
  doc_back_url     text,
  selfie_url       text,
  full_name        varchar(100),
  birth_date       date,
  doc_number       varchar(50),
  reviewer_note    text,
  submitted_at     timestamptz   NOT NULL DEFAULT now(),
  reviewed_at      timestamptz,
  CONSTRAINT kyc_submissions_status_check CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX kyc_submissions_wallet_user_id_idx ON kyc_submissions (wallet_user_id);
CREATE INDEX kyc_submissions_status_idx ON kyc_submissions (status);

-- Track when user submitted KYC
ALTER TABLE wallet_users ADD COLUMN IF NOT EXISTS kyc_submitted_at timestamptz;

-- Supabase Storage bucket (private) for KYC documents
-- Run this via Supabase dashboard or service_role client if not auto-created:
INSERT INTO storage.buckets (id, name, public)
VALUES ('kyc-docs', 'kyc-docs', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policy: service_role only (no public access)
-- No SELECT / INSERT policies needed since we use service_role key server-side
