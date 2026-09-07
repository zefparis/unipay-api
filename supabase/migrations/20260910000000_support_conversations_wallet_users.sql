-- Extend support_conversations and support_messages to support wallet users.
-- Previously these tables were merchant-only. Now a conversation belongs to
-- EITHER a merchant OR a wallet user — never both, never neither.
-- The CHECK constraint enforces exactly-one-owner.

-- 1. Make merchant_id nullable (was NOT NULL)
ALTER TABLE public.support_conversations
  ALTER COLUMN merchant_id DROP NOT NULL;

-- 2. Add wallet_user_id column
ALTER TABLE public.support_conversations
  ADD COLUMN IF NOT EXISTS wallet_user_id uuid
  REFERENCES public.wallet_users(id) ON DELETE CASCADE;

-- 3. CHECK: exactly one of merchant_id / wallet_user_id must be set
ALTER TABLE public.support_conversations
  ADD CONSTRAINT support_conversations_exactly_one_owner
  CHECK (
    (merchant_id IS NOT NULL AND wallet_user_id IS NULL)
    OR
    (merchant_id IS NULL AND wallet_user_id IS NOT NULL)
  );

-- 4. Index for wallet_user_id lookups
CREATE INDEX IF NOT EXISTS idx_support_conversations_wallet_user_id
  ON public.support_conversations(wallet_user_id);

-- 5. Add 'wallet' to the role CHECK on support_messages
--    (wallet users send messages with role='wallet', mirroring 'merchant')
ALTER TABLE public.support_messages
  DROP CONSTRAINT IF EXISTS support_messages_role_check;
ALTER TABLE public.support_messages
  ADD CONSTRAINT support_messages_role_check
  CHECK (role IN ('merchant', 'bot', 'admin', 'wallet'));

-- 6. RLS policy for wallet users (mirrors the merchant policy)
CREATE POLICY IF NOT EXISTS support_conversations_wallet_user_isolation
  ON public.support_conversations
  FOR ALL
  USING (wallet_user_id = current_setting('app.current_wallet_user_id', true)::uuid);

-- The existing support_messages_via_conversation policy only checks
-- merchant_id. We need a parallel policy for wallet_user_id.
-- Since RLS policies are OR'd, we add a second policy for wallet-owned conversations.
CREATE POLICY IF NOT EXISTS support_messages_via_wallet_conversation
  ON public.support_messages
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.support_conversations sc
      WHERE sc.id = support_messages.conversation_id
        AND sc.wallet_user_id = current_setting('app.current_wallet_user_id', true)::uuid
    )
  );
