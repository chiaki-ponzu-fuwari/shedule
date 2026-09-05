-- Fresh-project base schema for the group features used by the existing app.
-- This migration intentionally runs before the historical 001-004 hardening
-- migrations so those migrations are reproducible on an empty Supabase project.

begin;

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  color text not null check (char_length(color) between 1 and 32),
  emoji text not null default '' check (char_length(emoji) <= 32),
  invite_code text not null unique check (char_length(invite_code) between 1 and 32),
  shared_memo text not null default '' check (octet_length(shared_memo) <= 1048576),
  owner_user_id text,
  last_deleter_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id text not null,
  user_name text not null default '' check (char_length(user_name) <= 120),
  color text not null check (char_length(color) between 1 and 32),
  is_owner boolean not null default false,
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create table if not exists public.shared_entries (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  user_id text not null,
  user_name text not null default '' check (char_length(user_name) <= 120),
  user_color text not null check (char_length(user_color) between 1 and 32),
  date date not null,
  main_stamp_text text,
  main_stamp_bg text,
  main_stamp_text_color text,
  mini_left_text text,
  mini_left_bg text,
  mini_right_text text,
  mini_right_bg text,
  notes text,
  time_slots text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, user_id, date),
  foreign key (group_id, user_id)
    references public.group_members (group_id, user_id)
    on delete cascade
);

create index if not exists group_members_user_id_group_id_idx
  on public.group_members (user_id, group_id);
create index if not exists group_members_group_id_owner_idx
  on public.group_members (group_id, is_owner)
  where is_owner = true;
create index if not exists groups_owner_user_id_idx
  on public.groups (owner_user_id)
  where owner_user_id is not null;
create index if not exists groups_last_deleter_user_id_idx
  on public.groups (last_deleter_user_id)
  where last_deleter_user_id is not null;
create index if not exists shared_entries_group_id_date_idx
  on public.shared_entries (group_id, date);
create index if not exists shared_entries_user_id_group_id_idx
  on public.shared_entries (user_id, group_id);

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.shared_entries enable row level security;

revoke all on table public.groups from public;
revoke all on table public.groups from anon;
revoke all on table public.groups from authenticated;
revoke all on table public.groups from service_role;
revoke all on table public.group_members from public;
revoke all on table public.group_members from anon;
revoke all on table public.group_members from authenticated;
revoke all on table public.group_members from service_role;
revoke all on table public.shared_entries from public;
revoke all on table public.shared_entries from anon;
revoke all on table public.shared_entries from authenticated;
revoke all on table public.shared_entries from service_role;

grant select, insert, update, delete on table public.groups to authenticated;
grant select, insert, update, delete on table public.group_members to authenticated;
grant select, insert, update, delete on table public.shared_entries to authenticated;
grant select, insert, update, delete on table public.groups to service_role;
grant select, insert, update, delete on table public.group_members to service_role;
grant select, insert, update, delete on table public.shared_entries to service_role;

commit;
