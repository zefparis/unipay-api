-- Support conversations and messages for merchant support bot

CREATE TABLE IF NOT EXISTS public.support_conversations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  uuid        NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  status       text        NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'escalated', 'resolved')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_conversations_merchant_id
  ON public.support_conversations(merchant_id);

CREATE INDEX IF NOT EXISTS idx_support_conversations_status
  ON public.support_conversations(status);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL REFERENCES public.support_conversations(id) ON DELETE CASCADE,
  role            text        NOT NULL
                              CHECK (role IN ('merchant', 'bot', 'admin')),
  content         text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_conversation_id
  ON public.support_messages(conversation_id);

-- RLS: merchants can only see their own conversations
ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY support_conversations_merchant_isolation
  ON public.support_conversations
  FOR ALL
  USING (merchant_id = current_setting('app.current_merchant_id', true)::uuid);

ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY support_messages_via_conversation
  ON public.support_messages
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.support_conversations sc
      WHERE sc.id = support_messages.conversation_id
        AND sc.merchant_id = current_setting('app.current_merchant_id', true)::uuid
    )
  );
