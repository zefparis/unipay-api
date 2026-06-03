-- ============================================================
-- UniPay Congo — Initial Schema
-- ============================================================

create extension if not exists "uuid-ossp";

-- ============================================================
-- operators
-- ============================================================
create table if not exists operators (
  id            uuid        primary key default uuid_generate_v4(),
  name          text        not null,
  email         text        not null unique,
  balance_usd   numeric(18, 6) not null default 0,
  status        text        not null default 'active'
                            check (status in ('active', 'suspended', 'pending')),
  webhook_url   text,
  is_admin      boolean     not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- api_keys
-- key format : upc_live_<32 random chars>
-- key_prefix : first 12 chars — used for O(1) lookup
-- key_hash   : bcrypt hash of the full key
-- ============================================================
create table if not exists api_keys (
  id            uuid        primary key default uuid_generate_v4(),
  operator_id   uuid        not null references operators(id) on delete cascade,
  key_prefix    text        not null,
  key_hash      text        not null,
  label         text        not null default 'Default',
  is_active     boolean     not null default true,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists api_keys_prefix_idx    on api_keys(key_prefix);
create index if not exists api_keys_operator_idx  on api_keys(operator_id);

-- ============================================================
-- transactions
-- ============================================================
create table if not exists transactions (
  id                uuid        primary key default uuid_generate_v4(),
  operator_id       uuid        not null references operators(id),
  channel           text        not null
                                check (channel in ('vodacash','orange','airtel','afrimoney','usdt')),
  direction         text        not null
                                check (direction in ('deposit','withdraw')),
  amount_usd        numeric(18, 6) not null,
  amount_local      numeric(18, 2) not null,
  currency          text        not null,
  phone             text        not null,
  status            text        not null default 'pending'
                                check (status in ('pending','processing','success','failed')),
  provider_ref      text,
  callback_payload  jsonb,
  error_message     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists transactions_operator_idx   on transactions(operator_id);
create index if not exists transactions_status_idx     on transactions(status);
create index if not exists transactions_provider_ref   on transactions(provider_ref);
create index if not exists transactions_created_at_idx on transactions(created_at desc);

-- ============================================================
-- auto-update updated_at trigger
-- ============================================================
create or replace function _set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger operators_updated_at
  before update on operators
  for each row execute function _set_updated_at();

create trigger transactions_updated_at
  before update on transactions
  for each row execute function _set_updated_at();

-- ============================================================
-- RLS — disabled; access via service_role key only
-- ============================================================
alter table operators    disable row level security;
alter table api_keys     disable row level security;
alter table transactions disable row level security;
