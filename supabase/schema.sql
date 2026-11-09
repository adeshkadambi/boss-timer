-- Boss Timer cloud sync. Run once in your Supabase project: SQL Editor -> New query -> paste -> Run.
-- Each row is one finished focus session, visible only to the account that created it.

create table if not exists public.sessions (
  id              uuid primary key,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_source     text not null,
  task_id         text,
  task_title      text not null,
  project         text,
  -- Kept as the local RFC 3339 text the app logged (e.g. 2026-11-09T14:00:00-05:00): Reports
  -- group by its first 10 characters, so converting to UTC would move sessions to other days.
  started_at      text not null,
  ended_at        text,
  planned_secs    integer not null,
  timed_secs      integer not null,
  rating          integer,
  focused_secs    integer not null,
  ended_naturally boolean not null default false,
  deleted         boolean not null default false,
  updated_at      timestamptz not null default now()
);

create index if not exists sessions_user_updated on public.sessions (user_id, updated_at, id);

-- The server stamps updated_at, so computers with different clocks still agree on what's new.
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists sessions_touch on public.sessions;
create trigger sessions_touch before insert or update on public.sessions
  for each row execute function public.touch_updated_at();

alter table public.sessions enable row level security;

drop policy if exists "own sessions" on public.sessions;
create policy "own sessions" on public.sessions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
