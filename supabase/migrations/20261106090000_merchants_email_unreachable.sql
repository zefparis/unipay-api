-- Flag « injoignable par email » (hard bounce, blacklist Brevo, plainte).
-- Posé en attendant la colonne via merchant_kyc_events.event='email_unreachable'
-- (même mécanisme d'exclusion que kyc-reminders.ts / kyc-campaign.ts).
alter table public.merchants
  add column if not exists email_unreachable boolean not null default false;

create index if not exists merchants_email_unreachable_idx
  on public.merchants (email_unreachable) where email_unreachable;
