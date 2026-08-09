-- Kaishi SRS — cross-device sync schema.
-- Run once: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run; every statement is idempotent.

create table if not exists public.user_state (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  progress       jsonb not null default '{}'::jsonb,
  settings       jsonb not null default '{}'::jsonb,
  mistakes       jsonb not null default '[]'::jsonb,
  activity_dates jsonb not null default '[]'::jsonb,
  review_history jsonb not null default '{}'::jsonb,
  daily_lessons  jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);

-- The publishable key ships inside the client, so anyone can read it out of
-- the page source. Row-level security is the only thing keeping one account's
-- data private from another's — these policies are not optional.
alter table public.user_state enable row level security;

drop policy if exists "read own state"   on public.user_state;
drop policy if exists "insert own state" on public.user_state;
drop policy if exists "update own state" on public.user_state;

create policy "read own state" on public.user_state
  for select using (auth.uid() = user_id);

create policy "insert own state" on public.user_state
  for insert with check (auth.uid() = user_id);

create policy "update own state" on public.user_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Stamp updated_at on the server so "which device wrote last" never depends on
-- two devices agreeing about the time.
create or replace function public.touch_user_state()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_state_touch on public.user_state;
create trigger user_state_touch
  before insert or update on public.user_state
  for each row execute function public.touch_user_state();
