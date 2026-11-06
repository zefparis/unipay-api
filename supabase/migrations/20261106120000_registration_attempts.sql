-- Quota d'inscriptions par IP persisté (remplace le compteur en mémoire,
-- remis à zéro à chaque redémarrage du service).
create table if not exists public.registration_attempts (
  id          bigint generated always as identity primary key,
  ip          text not null,
  merchant_id uuid,
  created_at  timestamptz not null default now()
);

create index if not exists registration_attempts_ip_day_idx
  on public.registration_attempts (ip, created_at);

alter table public.registration_attempts enable row level security;
revoke all on public.registration_attempts from public, anon, authenticated;
grant select, insert on public.registration_attempts to service_role;
