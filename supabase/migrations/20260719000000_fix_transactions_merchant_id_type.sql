-- ════════════════════════════════════════════════════════════════════════════
-- Corrective migration: fix transactions.merchant_id type text → uuid
-- Purpose: In the original migration 20260604000000, merchant_id was created
--          as TEXT but references operators.id which is UUID.
--          This migration corrects the type on databases where the original
--          migration was already applied.
--
-- Preconditions:
--   - operators.id is UUID
--   - transactions.merchant_id exists (as text or uuid)
--
-- This migration is idempotent: if merchant_id is already uuid, it does nothing.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_col_type TEXT;
BEGIN
  SELECT data_type INTO v_col_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transactions'
      AND column_name = 'merchant_id';

  IF v_col_type = 'text' THEN
    -- Drop the FK constraint first
    ALTER TABLE public.transactions
      DROP CONSTRAINT IF EXISTS transactions_merchant_id_fkey;

    -- Convert text column to uuid
    -- Any invalid text values will cause an error (expected: they should all be valid UUIDs)
    ALTER TABLE public.transactions
      ALTER COLUMN merchant_id TYPE uuid USING merchant_id::uuid;

    -- Recreate the FK constraint
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_merchant_id_fkey
        FOREIGN KEY (merchant_id) REFERENCES public.operators(id) ON DELETE RESTRICT;

    RAISE NOTICE 'Converted transactions.merchant_id from text to uuid';
  ELSIF v_col_type = 'uuid' THEN
    RAISE NOTICE 'transactions.merchant_id is already uuid, no action needed';
  ELSE
    RAISE NOTICE 'transactions.merchant_id column type is %, skipping', v_col_type;
  END IF;
END $$;
