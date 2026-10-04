-- Housey: two roles (admin, player) and the shared game state.
--
-- Run this ONCE in your Supabase project:
--   Dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
-- It is safe to run again.
--
-- Who can do what (enforced here, by Postgres row level security, so it holds
-- even though the publishable key in the browser is public):
--
--   public.game_public  what players see: status, numbers called, prize winners.
--                       Anyone can read it. Only an admin can change it.
--   public.game_admin   tickets, the armed prize fixes, settings.
--                       Only an admin can read or change it. Players cannot.
--   public.profiles     one row per signed-in user with their role.
--                       Users can read their own row. Nobody can change a role
--                       through the API; you promote an admin once, below.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'player' check (role in ('admin', 'player')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- Every new account starts as a player.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Accounts that existed before this migration become players.
insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists "profiles: admins read all" on public.profiles;
create policy "profiles: admins read all" on public.profiles
  for select to authenticated
  using ((select public.is_admin()));

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Shared timestamps
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- What players see (single row, id = 1)
-- ---------------------------------------------------------------------------

create table if not exists public.game_public (
  id integer primary key default 1 check (id = 1),
  status text not null default 'setup' check (status in ('setup', 'running', 'finished')),
  called integer[] not null default '{}' check (cardinality(called) <= 90),
  current_number integer check (current_number between 1 and 90),
  wins jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.game_public (id) values (1) on conflict (id) do nothing;

alter table public.game_public enable row level security;

drop trigger if exists game_public_touch on public.game_public;
create trigger game_public_touch
  before update on public.game_public
  for each row execute function public.touch_updated_at();

drop policy if exists "game_public: anyone can watch" on public.game_public;
create policy "game_public: anyone can watch" on public.game_public
  for select to anon, authenticated
  using (true);

drop policy if exists "game_public: admins insert" on public.game_public;
create policy "game_public: admins insert" on public.game_public
  for insert to authenticated
  with check ((select public.is_admin()));

drop policy if exists "game_public: admins update" on public.game_public;
create policy "game_public: admins update" on public.game_public
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.game_public from anon, authenticated;
grant select on public.game_public to anon, authenticated;
grant insert, update on public.game_public to authenticated;

-- ---------------------------------------------------------------------------
-- What only the admin sees (single row, id = 1): tickets and the armed fixes
-- ---------------------------------------------------------------------------

create table if not exists public.game_admin (
  id integer primary key default 1 check (id = 1),
  tickets jsonb not null default '[]'::jsonb,
  rigs jsonb not null default '{}'::jsonb,
  decoy_count integer not null default 2 check (decoy_count between 0 and 89),
  updated_at timestamptz not null default now()
);

insert into public.game_admin (id) values (1) on conflict (id) do nothing;

alter table public.game_admin enable row level security;

drop trigger if exists game_admin_touch on public.game_admin;
create trigger game_admin_touch
  before update on public.game_admin
  for each row execute function public.touch_updated_at();

drop policy if exists "game_admin: admins only" on public.game_admin;
create policy "game_admin: admins only" on public.game_admin
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.game_admin from anon, authenticated;
grant select, insert, update on public.game_admin to authenticated;

-- ---------------------------------------------------------------------------
-- Live updates for players. Only the public table is published: tickets and
-- fixes must never travel over the realtime channel.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_public'
     ) then
    alter publication supabase_realtime add table public.game_public;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Make yourself the admin (run this separately, ONCE, after the account exists)
--
-- Create your account first: Dashboard -> Authentication -> Users -> Add user
-- -> Create new user (tick "Auto Confirm User"), or sign up in the app. Then
-- replace the email and run:
--
--   update public.profiles
--      set role = 'admin'
--    where id = (select id from auth.users where lower(email) = lower('YOUR_EMAIL_HERE'));
--
-- Check it worked:
--
--   select u.email, p.role from public.profiles p join auth.users u on u.id = p.id;
-- ---------------------------------------------------------------------------
