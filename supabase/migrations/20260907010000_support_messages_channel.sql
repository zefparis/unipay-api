-- Add channel and subject columns to support_messages
-- channel: 'chat' (default, existing messages) or 'email' (admin direct emails)
-- subject: nullable, only used for channel='email' messages

ALTER TABLE public.support_messages
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'chat'
  CHECK (channel IN ('chat', 'email'));

ALTER TABLE public.support_messages
  ADD COLUMN IF NOT EXISTS subject text;
