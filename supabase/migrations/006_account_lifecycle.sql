-- Server-controlled account merge and deletion lifecycle. Edge Functions call
-- these RPCs with the service-role client only after validating the caller JWT.

begin;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;
grant usage on schema private to service_role;

create table if not exists public.account_merge_intents (
  id uuid primary key default gen_random_uuid(),
  -- These UUIDs deliberately have no auth.users FK. A completed intent is the
  -- idempotency receipt used after the source Auth row has been deleted.
  source_user_id uuid not null,
  target_user_id uuid,
  nonce_hash text not null unique check (nonce_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  used_at timestamptz,
  merged_at timestamptz,
  merge_result jsonb,
  delete_after timestamptz not null default (now() + interval '90 days'),
  check (expires_at > created_at),
  check (expires_at <= created_at + interval '10 minutes'),
  check (delete_after >= created_at + interval '90 days'),
  check (target_user_id is null or target_user_id <> source_user_id),
  check (used_at is null or target_user_id is not null),
  check ((merged_at is null) = (merge_result is null)),
  check (merged_at is null or used_at is not null)
);

create index if not exists account_merge_intents_source_user_id_idx
  on public.account_merge_intents (source_user_id);
create index if not exists account_merge_intents_target_user_id_idx
  on public.account_merge_intents (target_user_id)
  where target_user_id is not null;
create index if not exists account_merge_intents_unconsumed_expiry_idx
  on public.account_merge_intents (expires_at, nonce_hash)
  where used_at is null;
create unique index if not exists account_merge_intents_active_source_idx
  on public.account_merge_intents (source_user_id)
  where merged_at is null;
create index if not exists account_merge_intents_delete_after_idx
  on public.account_merge_intents (delete_after);

create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  -- Kept after auth.users deletion as an idempotency receipt, then nulled on
  -- completion. The durable deletion guard is the separate tombstone row.
  user_id uuid unique,
  request_id uuid not null unique,
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'challenged'
    check (status in ('challenged', 'authorized', 'processing', 'failed', 'db-cleared', 'completed')),
  attempts smallint not null default 0 check (attempts >= 0),
  manual_revocation_required boolean not null default false,
  error_code text check (error_code is null or char_length(error_code) <= 120),
  challenge_created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  authorized_at timestamptz,
  google_revocation_handled_at timestamptz,
  provider_revoked_at timestamptz,
  storage_cleared_at timestamptz,
  db_cleared_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  delete_after timestamptz not null default (now() + interval '90 days'),
  check (expires_at > challenge_created_at),
  check (expires_at <= challenge_created_at + interval '10 minutes'),
  check (delete_after >= challenge_created_at + interval '90 days'),
  check ((status = 'completed') = (completed_at is not null)),
  check ((status = 'completed') = (user_id is null)),
  check (status = 'challenged' or authorized_at is not null),
  check (db_cleared_at is null or (provider_revoked_at is not null and storage_cleared_at is not null)),
  check (status not in ('db-cleared', 'completed') or db_cleared_at is not null)
);

alter table public.account_deletion_requests
  add column if not exists google_revocation_handled_at timestamptz;

create index if not exists account_deletion_requests_user_id_status_idx
  on public.account_deletion_requests (user_id, status);
create index if not exists account_deletion_requests_pending_idx
  on public.account_deletion_requests (updated_at, user_id)
  where status in ('authorized', 'processing', 'failed', 'db-cleared');
create index if not exists account_deletion_requests_challenge_expiry_idx
  on public.account_deletion_requests (expires_at)
  where status = 'challenged';
create index if not exists account_deletion_requests_delete_after_idx
  on public.account_deletion_requests (delete_after)
  where status in ('completed', 'challenged');

-- Deliberately has no auth.users foreign key: a revoked UID must remain blocked
-- after GoTrue deletes the auth row and until every JWT issued for it is stale.
-- Only the non-PII UUID and security lifecycle metadata are retained.
create table if not exists public.deleted_account_tombstones (
  user_id uuid primary key,
  reason text not null check (reason in ('deleted', 'merged')),
  replacement_user_id uuid,
  deleted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  delete_after timestamptz not null default (now() + interval '90 days'),
  check (delete_after = deleted_at + interval '90 days'),
  check (replacement_user_id is null or replacement_user_id <> user_id)
);

create index if not exists deleted_account_tombstones_deleted_at_idx
  on public.deleted_account_tombstones (deleted_at);
create index if not exists deleted_account_tombstones_delete_after_idx
  on public.deleted_account_tombstones (delete_after);
create index if not exists deleted_account_tombstones_replacement_user_id_idx
  on public.deleted_account_tombstones (replacement_user_id)
  where replacement_user_id is not null;

create table if not exists private.apple_credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  provider_subject_hash text not null
    check (provider_subject_hash ~ '^[0-9a-f]{64}$'),
  encrypted_refresh_token bytea not null
    check (octet_length(encrypted_refresh_token) between 16 and 16384),
  encryption_key_id text not null
    check (char_length(encryption_key_id) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.account_merge_intents enable row level security;
alter table public.account_merge_intents force row level security;
alter table public.account_deletion_requests enable row level security;
alter table public.account_deletion_requests force row level security;
alter table public.deleted_account_tombstones enable row level security;
alter table public.deleted_account_tombstones force row level security;
alter table private.apple_credentials enable row level security;
alter table private.apple_credentials force row level security;

drop policy if exists account_deletion_requests_owner_read on public.account_deletion_requests;

revoke all on table public.account_merge_intents from public;
revoke all on table public.account_merge_intents from anon;
revoke all on table public.account_merge_intents from authenticated;
revoke all on table public.account_deletion_requests from public;
revoke all on table public.account_deletion_requests from anon;
revoke all on table public.account_deletion_requests from authenticated;
revoke all on table public.deleted_account_tombstones from public;
revoke all on table public.deleted_account_tombstones from anon;
revoke all on table public.deleted_account_tombstones from authenticated;
revoke all on table private.apple_credentials from public;
revoke all on table private.apple_credentials from anon;
revoke all on table private.apple_credentials from authenticated;

grant select, insert, update, delete on table public.account_merge_intents to service_role;
grant select, insert, update, delete on table public.account_deletion_requests to service_role;
grant select, insert, update, delete on table public.deleted_account_tombstones to service_role;
grant select, insert, update, delete on table private.apple_credentials to service_role;

create or replace function public.current_personal_cloud_identity_is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    auth.uid() is not null
    and auth.role() = 'authenticated'
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    and exists (
      select 1 from auth.users au
      where au.id = auth.uid() and coalesce(au.is_anonymous, false) = false
    )
    and not exists (
      select 1 from public.account_deletion_requests adr
      where adr.user_id = auth.uid() and adr.authorized_at is not null
    )
    and not exists (
      select 1 from public.deleted_account_tombstones dat
      where dat.user_id = auth.uid()
    );
$$;

revoke all on function public.current_personal_cloud_identity_is_active() from public;
revoke all on function public.current_personal_cloud_identity_is_active() from anon;
revoke all on function public.current_personal_cloud_identity_is_active() from authenticated;
grant execute on function public.current_personal_cloud_identity_is_active() to authenticated, service_role;

-- Supabase anonymous users have role=authenticated and are valid group
-- collaborators. They are intentionally excluded only from personal backup.
create or replace function public.current_group_identity_is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    auth.uid() is not null
    and auth.role() = 'authenticated'
    and exists (
      select 1 from auth.users au where au.id = auth.uid()
    )
    and not exists (
      select 1 from public.account_deletion_requests adr
      where adr.user_id = auth.uid() and adr.authorized_at is not null
    )
    and not exists (
      select 1 from public.deleted_account_tombstones dat
      where dat.user_id = auth.uid()
    );
$$;

revoke all on function public.current_group_identity_is_active() from public;
revoke all on function public.current_group_identity_is_active() from anon;
revoke all on function public.current_group_identity_is_active() from authenticated;
grant execute on function public.current_group_identity_is_active() to authenticated, service_role;

-- Direct client writes are protected by restrictive policies. The trigger below
-- also protects writes made through SECURITY DEFINER functions.
drop policy if exists profiles_deletion_guard_insert on public.profiles;
create policy profiles_deletion_guard_insert on public.profiles as restrictive
  for insert to authenticated
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists profiles_deletion_guard_update on public.profiles;
create policy profiles_deletion_guard_update on public.profiles as restrictive
  for update to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists profiles_deletion_guard_delete on public.profiles;
create policy profiles_deletion_guard_delete on public.profiles as restrictive
  for delete to authenticated
  using ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists personal_calendar_entries_deletion_guard_insert on public.personal_calendar_entries;
create policy personal_calendar_entries_deletion_guard_insert on public.personal_calendar_entries as restrictive
  for insert to authenticated
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists personal_calendar_entries_deletion_guard_update on public.personal_calendar_entries;
create policy personal_calendar_entries_deletion_guard_update on public.personal_calendar_entries as restrictive
  for update to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists personal_calendar_entries_deletion_guard_delete on public.personal_calendar_entries;
create policy personal_calendar_entries_deletion_guard_delete on public.personal_calendar_entries as restrictive
  for delete to authenticated
  using ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists personal_special_dates_deletion_guard_insert on public.personal_special_dates;
create policy personal_special_dates_deletion_guard_insert on public.personal_special_dates as restrictive
  for insert to authenticated
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists personal_special_dates_deletion_guard_update on public.personal_special_dates;
create policy personal_special_dates_deletion_guard_update on public.personal_special_dates as restrictive
  for update to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists personal_special_dates_deletion_guard_delete on public.personal_special_dates;
create policy personal_special_dates_deletion_guard_delete on public.personal_special_dates as restrictive
  for delete to authenticated
  using ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists personal_preferences_deletion_guard_insert on public.personal_preferences;
create policy personal_preferences_deletion_guard_insert on public.personal_preferences as restrictive
  for insert to authenticated
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists personal_preferences_deletion_guard_update on public.personal_preferences;
create policy personal_preferences_deletion_guard_update on public.personal_preferences as restrictive
  for update to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists personal_preferences_deletion_guard_delete on public.personal_preferences;
create policy personal_preferences_deletion_guard_delete on public.personal_preferences as restrictive
  for delete to authenticated
  using ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists personal_stamps_deletion_guard_insert on public.personal_stamps;
create policy personal_stamps_deletion_guard_insert on public.personal_stamps as restrictive
  for insert to authenticated
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists personal_stamps_deletion_guard_update on public.personal_stamps;
create policy personal_stamps_deletion_guard_update on public.personal_stamps as restrictive
  for update to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists personal_stamps_deletion_guard_delete on public.personal_stamps;
create policy personal_stamps_deletion_guard_delete on public.personal_stamps as restrictive
  for delete to authenticated
  using ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists personal_trips_deletion_guard_insert on public.personal_trips;
create policy personal_trips_deletion_guard_insert on public.personal_trips as restrictive
  for insert to authenticated
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists personal_trips_deletion_guard_update on public.personal_trips;
create policy personal_trips_deletion_guard_update on public.personal_trips as restrictive
  for update to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists personal_trips_deletion_guard_delete on public.personal_trips;
create policy personal_trips_deletion_guard_delete on public.personal_trips as restrictive
  for delete to authenticated
  using ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists personal_trip_items_deletion_guard_insert on public.personal_trip_items;
create policy personal_trip_items_deletion_guard_insert on public.personal_trip_items as restrictive
  for insert to authenticated
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists personal_trip_items_deletion_guard_update on public.personal_trip_items;
create policy personal_trip_items_deletion_guard_update on public.personal_trip_items as restrictive
  for update to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists personal_trip_items_deletion_guard_delete on public.personal_trip_items;
create policy personal_trip_items_deletion_guard_delete on public.personal_trip_items as restrictive
  for delete to authenticated
  using ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists sync_mutations_deletion_guard_insert on public.sync_mutations;
create policy sync_mutations_deletion_guard_insert on public.sync_mutations as restrictive
  for insert to authenticated
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists sync_mutations_deletion_guard_update on public.sync_mutations;
create policy sync_mutations_deletion_guard_update on public.sync_mutations as restrictive
  for update to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));
drop policy if exists sync_mutations_deletion_guard_delete on public.sync_mutations;
create policy sync_mutations_deletion_guard_delete on public.sync_mutations as restrictive
  for delete to authenticated
  using ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists profiles_active_identity on public.profiles;
create policy profiles_active_identity on public.profiles as restrictive
  for all to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists personal_calendar_entries_active_identity on public.personal_calendar_entries;
create policy personal_calendar_entries_active_identity on public.personal_calendar_entries as restrictive
  for all to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists personal_special_dates_active_identity on public.personal_special_dates;
create policy personal_special_dates_active_identity on public.personal_special_dates as restrictive
  for all to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists personal_preferences_active_identity on public.personal_preferences;
create policy personal_preferences_active_identity on public.personal_preferences as restrictive
  for all to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists personal_stamps_active_identity on public.personal_stamps;
create policy personal_stamps_active_identity on public.personal_stamps as restrictive
  for all to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists personal_trips_active_identity on public.personal_trips;
create policy personal_trips_active_identity on public.personal_trips as restrictive
  for all to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists personal_trip_items_active_identity on public.personal_trip_items;
create policy personal_trip_items_active_identity on public.personal_trip_items as restrictive
  for all to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists sync_mutations_active_identity on public.sync_mutations;
create policy sync_mutations_active_identity on public.sync_mutations as restrictive
  for all to authenticated
  using ((select public.current_personal_cloud_identity_is_active()))
  with check ((select public.current_personal_cloud_identity_is_active()));

drop policy if exists groups_active_identity on public.groups;
create policy groups_active_identity on public.groups as restrictive
  for all to authenticated
  using ((select public.current_group_identity_is_active()))
  with check ((select public.current_group_identity_is_active()));

drop policy if exists group_members_active_identity on public.group_members;
create policy group_members_active_identity on public.group_members as restrictive
  for all to authenticated
  using ((select public.current_group_identity_is_active()))
  with check ((select public.current_group_identity_is_active()));

drop policy if exists shared_entries_active_identity on public.shared_entries;
create policy shared_entries_active_identity on public.shared_entries as restrictive
  for all to authenticated
  using ((select public.current_group_identity_is_active()))
  with check ((select public.current_group_identity_is_active()));

-- Replace the 005 Storage policies so a stale deleted-account JWT, or an
-- anonymous JWT presented as `authenticated`, cannot access the old UID path.
drop policy if exists personal_media_read on storage.objects;
create policy personal_media_read on storage.objects
  for select to authenticated
  using (
    (select public.current_personal_cloud_identity_is_active())
    and bucket_id = 'personal-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists personal_media_insert on storage.objects;
create policy personal_media_insert on storage.objects
  for insert to authenticated
  with check (
    (select public.current_personal_cloud_identity_is_active())
    and bucket_id = 'personal-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists personal_media_update on storage.objects;
create policy personal_media_update on storage.objects
  for update to authenticated
  using (
    (select public.current_personal_cloud_identity_is_active())
    and bucket_id = 'personal-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    (select public.current_personal_cloud_identity_is_active())
    and bucket_id = 'personal-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists personal_media_delete on storage.objects;
create policy personal_media_delete on storage.objects
  for delete to authenticated
  using (
    (select public.current_personal_cloud_identity_is_active())
    and bucket_id = 'personal-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Re-declare every group SECURITY DEFINER RPC after migrations 001-004. This
-- preserves their latest behavior while adding the permanent account guard
-- and an empty search_path to prevent object-shadowing attacks.
create or replace function public.is_member_of_group(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_group_identity_is_active()
    and exists (
      select 1
      from public.group_members
      where group_id = p_group_id and user_id = auth.uid()::text
    );
$$;

revoke all on function public.is_member_of_group(uuid) from public;
revoke all on function public.is_member_of_group(uuid) from anon;
revoke all on function public.is_member_of_group(uuid) from authenticated;
grant execute on function public.is_member_of_group(uuid) to authenticated;

create or replace function public.create_group_with_owner(
  p_name text,
  p_color text,
  p_emoji text,
  p_user_name text
)
returns public.groups
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group public.groups%rowtype;
  v_invite text;
  v_owner_count integer;
  v_max_groups integer := 10;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'cloud access is unavailable for this identity';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if not public.current_group_identity_is_active() then
    raise exception using errcode = '42501', message = 'cloud access is unavailable for this identity';
  end if;

  if p_name is null or length(trim(p_name)) < 1 or length(p_name) > 200 then
    raise exception using errcode = '22023', message = 'invalid name';
  end if;
  if p_color is null or length(p_color) not between 1 and 32 then
    raise exception using errcode = '22023', message = 'invalid color';
  end if;
  if p_emoji is not null and length(p_emoji) > 32 then
    raise exception using errcode = '22023', message = 'invalid emoji';
  end if;
  if p_user_name is not null and length(p_user_name) > 120 then
    raise exception using errcode = '22023', message = 'invalid user_name';
  end if;

  select count(*)::integer into v_owner_count
  from public.group_members
  where user_id = auth.uid()::text and is_owner = true;

  if v_owner_count >= v_max_groups then
    raise exception using errcode = '54000', message = 'group_limit_reached';
  end if;

  v_invite := upper(substring(md5(random()::text || clock_timestamp()::text || random()::text) from 1 for 6));
  insert into public.groups (name, color, emoji, invite_code, shared_memo, owner_user_id)
  values (trim(p_name), p_color, coalesce(p_emoji, ''), v_invite, '', auth.uid()::text)
  returning * into v_group;

  insert into public.group_members (group_id, user_id, user_name, color, is_owner)
  values (v_group.id, auth.uid()::text, coalesce(trim(p_user_name), ''), p_color, true);

  return v_group;
end;
$$;

revoke all on function public.create_group_with_owner(text, text, text, text) from public;
revoke all on function public.create_group_with_owner(text, text, text, text) from anon;
revoke all on function public.create_group_with_owner(text, text, text, text) from authenticated;
grant execute on function public.create_group_with_owner(text, text, text, text) to authenticated;

create or replace function public.join_group_by_invite(
  p_invite text,
  p_user_name text,
  p_color text
)
returns public.groups
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group public.groups%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'cloud access is unavailable for this identity';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if not public.current_group_identity_is_active() then
    raise exception using errcode = '42501', message = 'cloud access is unavailable for this identity';
  end if;

  if p_invite is null or length(trim(p_invite)) < 1 or length(p_invite) > 32 then
    raise exception using errcode = '22023', message = 'invalid invite';
  end if;
  if p_user_name is not null and length(p_user_name) > 120 then
    raise exception using errcode = '22023', message = 'invalid user_name';
  end if;
  if p_color is null or length(p_color) not between 1 and 32 then
    raise exception using errcode = '22023', message = 'invalid color';
  end if;

  select * into v_group
  from public.groups
  where upper(trim(invite_code)) = upper(trim(p_invite))
  limit 1;
  if not found then
    return null;
  end if;

  if exists (
    select 1 from public.group_members
    where group_id = v_group.id and user_id = auth.uid()::text
  ) then
    return v_group;
  end if;

  insert into public.group_members (group_id, user_id, user_name, color, is_owner)
  values (v_group.id, auth.uid()::text, coalesce(trim(p_user_name), ''), p_color, false);
  return v_group;
end;
$$;

revoke all on function public.join_group_by_invite(text, text, text) from public;
revoke all on function public.join_group_by_invite(text, text, text) from anon;
revoke all on function public.join_group_by_invite(text, text, text) from authenticated;
grant execute on function public.join_group_by_invite(text, text, text) to authenticated;

create or replace function private.reject_personal_write_during_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null
    and coalesce(auth.role(), 'authenticated') <> 'service_role' then
    perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
    if not public.current_personal_cloud_identity_is_active() then
      raise exception using errcode = '55000', message = 'cloud access is unavailable for this identity';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.reject_personal_write_during_deletion() from public;
revoke all on function private.reject_personal_write_during_deletion() from anon;
revoke all on function private.reject_personal_write_during_deletion() from authenticated;

create or replace function private.reject_group_write_during_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null
    and coalesce(auth.role(), 'authenticated') <> 'service_role' then
    perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
    if not public.current_group_identity_is_active() then
      raise exception using errcode = '55000', message = 'group access is unavailable for this identity';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.reject_group_write_during_deletion() from public;
revoke all on function private.reject_group_write_during_deletion() from anon;
revoke all on function private.reject_group_write_during_deletion() from authenticated;

drop trigger if exists profiles_reject_deletion_pending on public.profiles;
create trigger profiles_reject_deletion_pending
  before insert or update or delete on public.profiles
  for each row execute function private.reject_personal_write_during_deletion();
drop trigger if exists personal_calendar_entries_reject_deletion_pending on public.personal_calendar_entries;
create trigger personal_calendar_entries_reject_deletion_pending
  before insert or update or delete on public.personal_calendar_entries
  for each row execute function private.reject_personal_write_during_deletion();
drop trigger if exists personal_special_dates_reject_deletion_pending on public.personal_special_dates;
create trigger personal_special_dates_reject_deletion_pending
  before insert or update or delete on public.personal_special_dates
  for each row execute function private.reject_personal_write_during_deletion();
drop trigger if exists personal_preferences_reject_deletion_pending on public.personal_preferences;
create trigger personal_preferences_reject_deletion_pending
  before insert or update or delete on public.personal_preferences
  for each row execute function private.reject_personal_write_during_deletion();
drop trigger if exists personal_stamps_reject_deletion_pending on public.personal_stamps;
create trigger personal_stamps_reject_deletion_pending
  before insert or update or delete on public.personal_stamps
  for each row execute function private.reject_personal_write_during_deletion();
drop trigger if exists personal_trips_reject_deletion_pending on public.personal_trips;
create trigger personal_trips_reject_deletion_pending
  before insert or update or delete on public.personal_trips
  for each row execute function private.reject_personal_write_during_deletion();
drop trigger if exists personal_trip_items_reject_deletion_pending on public.personal_trip_items;
create trigger personal_trip_items_reject_deletion_pending
  before insert or update or delete on public.personal_trip_items
  for each row execute function private.reject_personal_write_during_deletion();
drop trigger if exists sync_mutations_reject_deletion_pending on public.sync_mutations;
create trigger sync_mutations_reject_deletion_pending
  before insert or update or delete on public.sync_mutations
  for each row execute function private.reject_personal_write_during_deletion();
drop trigger if exists groups_reject_deletion_pending on public.groups;
create trigger groups_reject_deletion_pending
  before insert or update or delete on public.groups
  for each row execute function private.reject_group_write_during_deletion();
drop trigger if exists group_members_reject_deletion_pending on public.group_members;
create trigger group_members_reject_deletion_pending
  before insert or update or delete on public.group_members
  for each row execute function private.reject_group_write_during_deletion();
drop trigger if exists shared_entries_reject_deletion_pending on public.shared_entries;
create trigger shared_entries_reject_deletion_pending
  before insert or update or delete on public.shared_entries
  for each row execute function private.reject_group_write_during_deletion();

create or replace function public.create_account_merge_intent(
  p_source_user_id uuid,
  p_nonce_hash text
)
returns public.account_merge_intents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.account_merge_intents%rowtype;
  v_created_at timestamptz;
begin
  if p_source_user_id is null then
    raise exception using errcode = '22023', message = 'source user is required';
  end if;
  if p_nonce_hash is null or p_nonce_hash !~ '^[0-9A-Fa-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid nonce hash';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_source_user_id::text, 0));
  perform 1
  from auth.users
  where id = p_source_user_id
    and coalesce(is_anonymous, false) = true
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'source must be an anonymous account';
  end if;
  if exists (
    select 1 from public.deleted_account_tombstones
    where user_id = p_source_user_id
  ) or exists (
    select 1 from public.account_deletion_requests
    where user_id = p_source_user_id and authorized_at is not null
  ) then
    raise exception using errcode = '55000', message = 'source account is unavailable';
  end if;

  delete from public.account_merge_intents
  where source_user_id = p_source_user_id
    and merged_at is null
    and expires_at <= clock_timestamp();

  if exists (
    select 1 from public.account_merge_intents
    where source_user_id = p_source_user_id
      and merged_at is null
      and expires_at > clock_timestamp()
  ) then
    raise exception using errcode = '55000', message = 'active merge intent already exists';
  end if;

  v_created_at := clock_timestamp();
  insert into public.account_merge_intents (
    source_user_id, nonce_hash, created_at, expires_at
  ) values (
    p_source_user_id, lower(p_nonce_hash), v_created_at, v_created_at + interval '10 minutes'
  )
  returning * into v_intent;

  return v_intent;
end;
$$;

create or replace function public.consume_account_merge_intent(
  p_nonce_hash text,
  p_target_user_id uuid
)
returns public.account_merge_intents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.account_merge_intents%rowtype;
  v_source_user_id uuid;
begin
  if p_nonce_hash is null or p_nonce_hash !~ '^[0-9A-Fa-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid nonce hash';
  end if;
  if p_target_user_id is null then
    raise exception using errcode = '22023', message = 'target user is required';
  end if;

  select source_user_id into v_source_user_id
  from public.account_merge_intents
  where nonce_hash = lower(p_nonce_hash);
  if not found or v_source_user_id = p_target_user_id then
    raise exception using errcode = '22023', message = 'merge intent is invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(least(v_source_user_id::text, p_target_user_id::text), 0));
  perform pg_advisory_xact_lock(hashtextextended(greatest(v_source_user_id::text, p_target_user_id::text), 0));

  select * into v_intent
  from public.account_merge_intents
  where nonce_hash = lower(p_nonce_hash)
    and source_user_id = v_source_user_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'merge intent is invalid';
  end if;

  if v_intent.used_at is not null then
    if v_intent.target_user_id is distinct from p_target_user_id then
      raise exception using errcode = '42501', message = 'merge intent belongs to another target';
    end if;
    if v_intent.merged_at is not null or v_intent.expires_at > clock_timestamp() then
      return v_intent;
    end if;
    raise exception using errcode = '22023', message = 'merge intent is expired';
  end if;

  if v_intent.expires_at <= clock_timestamp() then
    raise exception using errcode = '22023', message = 'merge intent is expired';
  end if;

  perform 1
  from auth.users
  where id = v_source_user_id
    and coalesce(is_anonymous, false) = true
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'source must be an anonymous account';
  end if;

  perform 1
  from auth.users
  where id = p_target_user_id and coalesce(is_anonymous, false) = false
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'target must be a non-anonymous account';
  end if;
  if exists (
    select 1 from public.deleted_account_tombstones
    where user_id in (v_source_user_id, p_target_user_id)
  ) or exists (
    select 1 from public.account_deletion_requests
    where user_id in (v_source_user_id, p_target_user_id)
      and authorized_at is not null
  ) then
    raise exception using errcode = '55000', message = 'merge account is unavailable';
  end if;

  update public.account_merge_intents
  set target_user_id = p_target_user_id,
      used_at = clock_timestamp()
  where id = v_intent.id
    and used_at is null
    and expires_at > clock_timestamp()
  returning * into v_intent;

  if not found then
    raise exception using errcode = '22023', message = 'merge intent is invalid, expired, or already used';
  end if;

  return v_intent;
end;
$$;

create or replace function public.cancel_account_merge_intent(
  p_intent_id uuid,
  p_source_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.account_merge_intents%rowtype;
begin
  if p_intent_id is null or p_source_user_id is null then
    raise exception using errcode = '22023', message = 'intent and source user are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_source_user_id::text, 0));
  select * into v_intent
  from public.account_merge_intents
  where id = p_intent_id
  for update;

  -- A repeated cancellation remains successful after the first delete.
  if not found then
    return true;
  end if;
  if v_intent.source_user_id <> p_source_user_id then
    raise exception using errcode = '42501', message = 'merge intent does not belong to source user';
  end if;
  if v_intent.used_at is not null then
    return false;
  end if;

  delete from public.account_merge_intents
  where id = p_intent_id
    and source_user_id = p_source_user_id
    and used_at is null;
  return true;
end;
$$;

create or replace function private.is_personal_media_object_key(
  p_value text,
  p_owner_id uuid
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_parts text[];
begin
  if p_value is null or p_owner_id is null then
    return false;
  end if;
  v_parts := string_to_array(p_value, '/');
  return array_length(v_parts, 1) = 3
    and v_parts[1] = p_owner_id::text
    and v_parts[2] in ('calendar', 'diary', 'stamp', 'trip')
    and v_parts[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$';
end;
$$;

revoke all on function private.is_personal_media_object_key(text, uuid) from public;
revoke all on function private.is_personal_media_object_key(text, uuid) from anon;
revoke all on function private.is_personal_media_object_key(text, uuid) from authenticated;

create or replace function private.payload_has_personal_media_key(
  p_payload jsonb,
  p_owner_id uuid
)
returns boolean
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  v_value jsonb;
  v_text text;
begin
  if p_payload is null then
    return false;
  end if;
  if jsonb_typeof(p_payload) = 'object' then
    for v_value in select value from jsonb_each(p_payload)
    loop
      if private.payload_has_personal_media_key(v_value, p_owner_id) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_payload) = 'array' then
    for v_value in select value from jsonb_array_elements(p_payload)
    loop
      if private.payload_has_personal_media_key(v_value, p_owner_id) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_payload) = 'string' then
    v_text := p_payload #>> '{}';
    return private.is_personal_media_object_key(v_text, p_owner_id);
  end if;
  return false;
end;
$$;

revoke all on function private.payload_has_personal_media_key(jsonb, uuid) from public;
revoke all on function private.payload_has_personal_media_key(jsonb, uuid) from anon;
revoke all on function private.payload_has_personal_media_key(jsonb, uuid) from authenticated;

create or replace function private.rewrite_personal_media_keys(
  p_payload jsonb,
  p_source_user_id uuid,
  p_target_user_id uuid
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_text text;
  v_result jsonb;
begin
  if p_payload is null then
    return null;
  end if;
  if jsonb_typeof(p_payload) = 'object' then
    select coalesce(
      jsonb_object_agg(entry.key, private.rewrite_personal_media_keys(
        entry.value, p_source_user_id, p_target_user_id
      )),
      '{}'::jsonb
    ) into v_result
    from jsonb_each(p_payload) as entry;
    return v_result;
  elsif jsonb_typeof(p_payload) = 'array' then
    select coalesce(
      jsonb_agg(private.rewrite_personal_media_keys(
        entry.value, p_source_user_id, p_target_user_id
      ) order by entry.ordinality),
      '[]'::jsonb
    ) into v_result
    from jsonb_array_elements(p_payload) with ordinality as entry(value, ordinality);
    return v_result;
  elsif jsonb_typeof(p_payload) = 'string' then
    v_text := p_payload #>> '{}';
    if private.is_personal_media_object_key(v_text, p_source_user_id) then
      return to_jsonb(
        p_target_user_id::text || substring(v_text from char_length(p_source_user_id::text) + 1)
      );
    end if;
  end if;
  return p_payload;
end;
$$;

revoke all on function private.rewrite_personal_media_keys(jsonb, uuid, uuid) from public;
revoke all on function private.rewrite_personal_media_keys(jsonb, uuid, uuid) from anon;
revoke all on function private.rewrite_personal_media_keys(jsonb, uuid, uuid) from authenticated;

create or replace function private.personal_media_copies_exist(
  p_payload jsonb,
  p_source_user_id uuid,
  p_target_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_value jsonb;
  v_text text;
  v_target_key text;
begin
  if p_payload is null then
    return true;
  end if;
  if jsonb_typeof(p_payload) = 'object' then
    for v_value in select value from jsonb_each(p_payload)
    loop
      if not private.personal_media_copies_exist(v_value, p_source_user_id, p_target_user_id) then
        return false;
      end if;
    end loop;
  elsif jsonb_typeof(p_payload) = 'array' then
    for v_value in select value from jsonb_array_elements(p_payload)
    loop
      if not private.personal_media_copies_exist(v_value, p_source_user_id, p_target_user_id) then
        return false;
      end if;
    end loop;
  elsif jsonb_typeof(p_payload) = 'string' then
    v_text := p_payload #>> '{}';
    if private.is_personal_media_object_key(v_text, p_source_user_id) then
      v_target_key := p_target_user_id::text
        || substring(v_text from char_length(p_source_user_id::text) + 1);
      return exists (
        select 1 from storage.objects
        where bucket_id = 'personal-media' and name = v_target_key
      );
    end if;
  end if;
  return true;
end;
$$;

revoke all on function private.personal_media_copies_exist(jsonb, uuid, uuid) from public;
revoke all on function private.personal_media_copies_exist(jsonb, uuid, uuid) from anon;
revoke all on function private.personal_media_copies_exist(jsonb, uuid, uuid) from authenticated;

create or replace function public.merge_account_data(
  p_intent_id uuid,
  p_source_user_id uuid,
  p_target_user_id uuid,
  p_media_copied boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.account_merge_intents%rowtype;
  v_pending_media jsonb;
  v_result jsonb;
begin
  if p_intent_id is null
    or p_source_user_id is null
    or p_target_user_id is null
    or p_source_user_id = p_target_user_id then
    raise exception using errcode = '22023', message = 'intent and distinct source and target users are required';
  end if;

  -- Serialize every lifecycle transition for both identities. Sorted locks
  -- avoid deadlocks when two service workers receive inverse requests.
  perform pg_advisory_xact_lock(hashtextextended(least(p_source_user_id::text, p_target_user_id::text), 0));
  perform pg_advisory_xact_lock(hashtextextended(greatest(p_source_user_id::text, p_target_user_id::text), 0));

  select * into v_intent
  from public.account_merge_intents
  where id = p_intent_id
    and source_user_id = p_source_user_id
    and target_user_id = p_target_user_id
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'consumed merge intent not found';
  end if;
  if v_intent.merged_at is not null then
    return v_intent.merge_result;
  end if;
  if v_intent.used_at is null or not (v_intent.expires_at > clock_timestamp()) then
    raise exception using errcode = '42501', message = 'merge intent is unused or expired';
  end if;

  perform 1
  from auth.users
  where id = p_source_user_id
    and coalesce(is_anonymous, false) = true
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'source must be an anonymous account';
  end if;

  perform 1
  from auth.users
  where id = p_target_user_id and coalesce(is_anonymous, false) = false
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'target must be a non-anonymous account';
  end if;

  if exists (
    select 1 from public.account_deletion_requests
    where user_id in (p_source_user_id, p_target_user_id)
      and authorized_at is not null
  ) or exists (
    select 1 from public.deleted_account_tombstones
    where user_id in (p_source_user_id, p_target_user_id)
  ) then
    raise exception using errcode = '55000', message = 'cannot merge an unavailable account';
  end if;

  -- PostgreSQL cannot move Storage objects between UID prefixes. Never copy a
  -- payload that could retain a source-owned media key. The service Edge
  -- Function must resolve these rows before retrying this still-unmerged
  -- intent; no database row is changed on this return path.
  select coalesce(jsonb_agg(candidate order by candidate ->> 'entity', candidate ->> 'entityId'), '[]'::jsonb)
  into v_pending_media
  from (
    select jsonb_build_object('entity', 'calendar-entry', 'entityId', source.entity_id) as candidate
    from public.personal_calendar_entries source
    where source.user_id = p_source_user_id
      and private.payload_has_personal_media_key(source.payload, p_source_user_id)
      and (
        not coalesce(p_media_copied, false)
        or not private.personal_media_copies_exist(
          source.payload, p_source_user_id, p_target_user_id
        )
      )
      and not exists (
        select 1 from public.personal_calendar_entries target
        where target.user_id = p_target_user_id and target.entity_id = source.entity_id
      )
    union all
    select jsonb_build_object('entity', 'special-date', 'entityId', source.entity_id)
    from public.personal_special_dates source
    where source.user_id = p_source_user_id
      and private.payload_has_personal_media_key(source.payload, p_source_user_id)
      and (
        not coalesce(p_media_copied, false)
        or not private.personal_media_copies_exist(
          source.payload, p_source_user_id, p_target_user_id
        )
      )
      and not exists (
        select 1 from public.personal_special_dates target
        where target.user_id = p_target_user_id and target.entity_id = source.entity_id
      )
    union all
    select jsonb_build_object('entity', 'preference', 'entityId', 'preferences')
    from public.personal_preferences source
    where source.user_id = p_source_user_id
      and private.payload_has_personal_media_key(source.payload, p_source_user_id)
      and (
        not coalesce(p_media_copied, false)
        or not private.personal_media_copies_exist(
          source.payload, p_source_user_id, p_target_user_id
        )
      )
      and not exists (
        select 1 from public.personal_preferences target
        where target.user_id = p_target_user_id
      )
    union all
    select jsonb_build_object('entity', 'stamp', 'entityId', source.entity_id)
    from public.personal_stamps source
    where source.user_id = p_source_user_id
      and private.payload_has_personal_media_key(source.payload, p_source_user_id)
      and (
        not coalesce(p_media_copied, false)
        or not private.personal_media_copies_exist(
          source.payload, p_source_user_id, p_target_user_id
        )
      )
      and not exists (
        select 1 from public.personal_stamps target
        where target.user_id = p_target_user_id and target.entity_id = source.entity_id
      )
    union all
    select jsonb_build_object('entity', 'trip', 'entityId', source.entity_id)
    from public.personal_trips source
    where source.user_id = p_source_user_id
      and private.payload_has_personal_media_key(source.payload, p_source_user_id)
      and (
        not coalesce(p_media_copied, false)
        or not private.personal_media_copies_exist(
          source.payload, p_source_user_id, p_target_user_id
        )
      )
      and not exists (
        select 1 from public.personal_trips target
        where target.user_id = p_target_user_id and target.entity_id = source.entity_id
      )
    union all
    select jsonb_build_object('entity', 'trip-item', 'entityId', source.entity_id)
    from public.personal_trip_items source
    where source.user_id = p_source_user_id
      and private.payload_has_personal_media_key(source.payload, p_source_user_id)
      and (
        not coalesce(p_media_copied, false)
        or not private.personal_media_copies_exist(
          source.payload, p_source_user_id, p_target_user_id
        )
      )
      and not exists (
        select 1 from public.personal_trip_items target
        where target.user_id = p_target_user_id and target.entity_id = source.entity_id
      )
  ) unresolved;

  if jsonb_array_length(v_pending_media) > 0 then
    return jsonb_build_object(
      'status', 'media-copy-required',
      'intentId', p_intent_id,
      'sourceUserId', p_source_user_id,
      'targetUserId', p_target_user_id,
      'pendingMedia', v_pending_media
    );
  end if;

  -- The existing target row is authoritative in every conflict. Source rows
  -- are inserted only for keys absent from the target, and receive a fresh
  -- change_sequence from the column default for safe incremental pulling.
  insert into public.profiles (
    user_id, display_name, schema_version, revision, created_at, updated_at, deleted_at
  )
  select p_target_user_id, display_name, schema_version, revision, created_at, updated_at, deleted_at
  from public.profiles where user_id = p_source_user_id
  on conflict (user_id) do nothing;

  insert into public.personal_calendar_entries (
    user_id, entity_id, payload, schema_version, revision, created_at, updated_at, deleted_at
  )
  select p_target_user_id, entity_id,
    private.rewrite_personal_media_keys(payload, p_source_user_id, p_target_user_id),
    schema_version, revision, created_at, updated_at, deleted_at
  from public.personal_calendar_entries where user_id = p_source_user_id
  on conflict (user_id, entity_id) do nothing;

  insert into public.personal_special_dates (
    user_id, entity_id, payload, schema_version, revision, created_at, updated_at, deleted_at
  )
  select p_target_user_id, entity_id,
    private.rewrite_personal_media_keys(payload, p_source_user_id, p_target_user_id),
    schema_version, revision, created_at, updated_at, deleted_at
  from public.personal_special_dates where user_id = p_source_user_id
  on conflict (user_id, entity_id) do nothing;

  insert into public.personal_preferences (
    user_id, payload, schema_version, revision, created_at, updated_at, deleted_at
  )
  select p_target_user_id,
    private.rewrite_personal_media_keys(payload, p_source_user_id, p_target_user_id),
    schema_version, revision, created_at, updated_at, deleted_at
  from public.personal_preferences where user_id = p_source_user_id
  on conflict (user_id) do nothing;

  insert into public.personal_stamps (
    user_id, entity_id, payload, schema_version, revision, created_at, updated_at, deleted_at
  )
  select p_target_user_id, entity_id,
    private.rewrite_personal_media_keys(payload, p_source_user_id, p_target_user_id),
    schema_version, revision, created_at, updated_at, deleted_at
  from public.personal_stamps where user_id = p_source_user_id
  on conflict (user_id, entity_id) do nothing;

  insert into public.personal_trips (
    user_id, entity_id, payload, schema_version, revision, created_at, updated_at, deleted_at
  )
  select p_target_user_id, entity_id,
    private.rewrite_personal_media_keys(payload, p_source_user_id, p_target_user_id),
    schema_version, revision, created_at, updated_at, deleted_at
  from public.personal_trips where user_id = p_source_user_id
  on conflict (user_id, entity_id) do nothing;

  insert into public.personal_trip_items (
    user_id, entity_id, trip_id, payload,
    schema_version, revision, created_at, updated_at, deleted_at
  )
  select p_target_user_id, entity_id, trip_id,
    private.rewrite_personal_media_keys(payload, p_source_user_id, p_target_user_id),
    schema_version, revision, created_at, updated_at, deleted_at
  from public.personal_trip_items where user_id = p_source_user_id
  on conflict (user_id, entity_id) do nothing;

  -- Membership and shared calendar rows follow the same target-wins rule.
  -- New identifiers avoid moving a source row identity into another account.
  insert into public.group_members (
    id, group_id, user_id, user_name, color, is_owner, created_at
  )
  select gen_random_uuid(), group_id, p_target_user_id::text, user_name, color, false, created_at
  from public.group_members where user_id = p_source_user_id::text
  on conflict (group_id, user_id) do nothing;

  insert into public.shared_entries (
    id, group_id, user_id, user_name, user_color, date,
    main_stamp_text, main_stamp_bg, main_stamp_text_color,
    mini_left_text, mini_left_bg, mini_right_text, mini_right_bg,
    notes, time_slots, created_at, updated_at
  )
  select gen_random_uuid(), group_id, p_target_user_id::text, user_name, user_color, date,
    main_stamp_text, main_stamp_bg, main_stamp_text_color,
    mini_left_text, mini_left_bg, mini_right_text, mini_right_bg,
    notes, time_slots, created_at, updated_at
  from public.shared_entries where user_id = p_source_user_id::text
  on conflict (group_id, user_id, date) do nothing;

  -- Ownership is an identity reference, not mergeable user content. Keep the
  -- group invariant aligned with the replacement identity.
  with transferred_groups as (
    update public.groups
    set owner_user_id = p_target_user_id::text
    where owner_user_id = p_source_user_id::text
    returning id
  )
  update public.group_members as member
  set is_owner = (member.user_id = p_target_user_id::text)
  from transferred_groups
  where member.group_id = transferred_groups.id;
  update public.groups
  set last_deleter_user_id = p_target_user_id::text
  where last_deleter_user_id = p_source_user_id::text;

  insert into private.apple_credentials (
    user_id, provider_subject_hash, encrypted_refresh_token, encryption_key_id,
    created_at, updated_at
  )
  select p_target_user_id, provider_subject_hash, encrypted_refresh_token, encryption_key_id,
    created_at, updated_at
  from private.apple_credentials where user_id = p_source_user_id
  on conflict (user_id) do nothing;

  -- Mutation acknowledgements are owner-specific evidence and are never
  -- copied or rewritten. A target-side mutation receives a new acknowledgement.
  insert into public.deleted_account_tombstones (
    user_id, reason, replacement_user_id, deleted_at
  ) values (
    p_source_user_id, 'merged', p_target_user_id, now()
  )
  on conflict (user_id) do nothing;

  delete from public.shared_entries where user_id = p_source_user_id::text;
  delete from public.group_members where user_id = p_source_user_id::text;
  delete from private.apple_credentials where user_id = p_source_user_id;
  delete from public.sync_mutations where user_id = p_source_user_id;
  delete from public.personal_calendar_entries where user_id = p_source_user_id;
  delete from public.personal_special_dates where user_id = p_source_user_id;
  delete from public.personal_preferences where user_id = p_source_user_id;
  delete from public.personal_stamps where user_id = p_source_user_id;
  delete from public.personal_trip_items where user_id = p_source_user_id;
  delete from public.personal_trips where user_id = p_source_user_id;
  delete from public.profiles where user_id = p_source_user_id;

  v_result := jsonb_build_object(
    'status', 'merged',
    'intentId', p_intent_id,
    'sourceUserId', p_source_user_id,
    'targetUserId', p_target_user_id
  );

  update public.account_merge_intents
  set merged_at = clock_timestamp(),
      merge_result = v_result,
      delete_after = clock_timestamp() + interval '90 days'
  where id = p_intent_id and merged_at is null;

  return v_result;
end;
$$;

create or replace function public.store_apple_credential(
  p_user_id uuid,
  p_provider_subject_hash text,
  p_ciphertext_base64 text,
  p_encryption_key_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ciphertext bytea;
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'user is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  perform 1
  from auth.users
  where id = p_user_id and coalesce(is_anonymous, false) = false
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'credential owner must be a non-anonymous account';
  end if;
  if exists (
    select 1 from public.account_deletion_requests
    where user_id = p_user_id and authorized_at is not null
  ) or exists (
    select 1 from public.deleted_account_tombstones where user_id = p_user_id
  ) then
    raise exception using errcode = '55000', message = 'credential owner is unavailable';
  end if;

  if p_provider_subject_hash is null or p_provider_subject_hash !~ '^[0-9A-Fa-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid provider subject hash';
  end if;
  if p_ciphertext_base64 is null or char_length(p_ciphertext_base64) > 32768 then
    raise exception using errcode = '22023', message = 'invalid encrypted credential';
  end if;
  if p_encryption_key_id is null or char_length(p_encryption_key_id) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid encryption key id';
  end if;

  begin
    v_ciphertext := decode(p_ciphertext_base64, 'base64');
  exception when others then
    raise exception using errcode = '22023', message = 'invalid encrypted credential encoding';
  end;
  if octet_length(v_ciphertext) not between 16 and 16384 then
    raise exception using errcode = '22023', message = 'invalid encrypted credential size';
  end if;

  insert into private.apple_credentials as credential (
    user_id, provider_subject_hash, encrypted_refresh_token, encryption_key_id
  ) values (
    p_user_id, lower(p_provider_subject_hash), v_ciphertext, p_encryption_key_id
  )
  on conflict (user_id) do update set
    provider_subject_hash = excluded.provider_subject_hash,
    encrypted_refresh_token = excluded.encrypted_refresh_token,
    encryption_key_id = excluded.encryption_key_id,
    updated_at = now();
end;
$$;

create or replace function public.get_apple_credential_for_deletion(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.account_deletion_requests%rowtype;
  v_credential jsonb;
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'user is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into v_request
  from public.account_deletion_requests
  where user_id = p_user_id
    and authorized_at is not null;
  if not found then
    raise exception using errcode = '42501', message = 'authorized provider deletion phase is required';
  end if;
  if v_request.provider_revoked_at is not null then
    return null;
  end if;

  select jsonb_build_object(
    'ciphertextBase64', replace(encode(encrypted_refresh_token, 'base64'), E'\n', ''),
    'encryptionKeyId', encryption_key_id
  ) into v_credential
  from private.apple_credentials
  where user_id = p_user_id;

  return v_credential;
end;
$$;

create or replace function public.has_apple_credential(
  p_user_id uuid,
  p_provider_subject_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if p_user_id is null
     or p_provider_subject_hash is null
     or p_provider_subject_hash !~ '^[0-9A-Fa-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid Apple credential lookup';
  end if;
  return exists (
    select 1
    from private.apple_credentials credential
    where credential.user_id = p_user_id
      and credential.provider_subject_hash = lower(p_provider_subject_hash)
  );
end;
$$;

create or replace function public.create_account_deletion_challenge(
  p_user_id uuid,
  p_request_id uuid,
  p_receipt_secret_hash text
)
returns public.account_deletion_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.account_deletion_requests%rowtype;
  v_created_at timestamptz;
begin
  if p_user_id is null or p_request_id is null
    or p_receipt_secret_hash is null
    or p_receipt_secret_hash !~ '^[0-9A-Fa-f]{64}$' then
    raise exception using errcode = '22023', message = 'valid user, request, and receipt hash are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  perform 1 from auth.users where id = p_user_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'deletion account does not exist';
  end if;
  if exists (
    select 1 from public.deleted_account_tombstones where user_id = p_user_id
  ) then
    raise exception using errcode = '55000', message = 'deletion account is unavailable';
  end if;

  select * into v_request
  from public.account_deletion_requests
  where request_id = p_request_id
  for update;
  if found then
    if v_request.user_id = p_user_id
      and v_request.receipt_hash = lower(p_receipt_secret_hash) then
      return v_request;
    end if;
    raise exception using errcode = '23505', message = 'request id is already in use';
  end if;

  select * into v_request
  from public.account_deletion_requests
  where user_id = p_user_id
  for update;
  if found then
    if v_request.status = 'challenged'
      and v_request.expires_at <= clock_timestamp() then
      delete from public.account_deletion_requests where id = v_request.id;
    else
      raise exception using errcode = '55000', message = 'active deletion request already exists';
    end if;
  end if;

  v_created_at := clock_timestamp();
  insert into public.account_deletion_requests (
    user_id, request_id, receipt_hash,
    challenge_created_at, expires_at, delete_after
  ) values (
    p_user_id, p_request_id, lower(p_receipt_secret_hash),
    v_created_at, v_created_at + interval '10 minutes',
    v_created_at + interval '90 days'
  )
  returning * into v_request;

  return v_request;
end;
$$;

create or replace function public.resume_account_deletion(
  p_user_id uuid,
  p_request_id uuid,
  p_receipt_secret_hash text
)
returns public.account_deletion_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.account_deletion_requests%rowtype;
begin
  if p_user_id is null or p_request_id is null
    or p_receipt_secret_hash is null
    or p_receipt_secret_hash !~ '^[0-9A-Fa-f]{64}$' then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into v_request
  from public.account_deletion_requests
  where user_id = p_user_id
    and request_id = p_request_id
    and receipt_hash = lower(p_receipt_secret_hash)
    and authorized_at is not null
    and status <> 'completed'
  for update;
  if not found then
    return null;
  end if;

  if not exists (
    select 1
    from public.deleted_account_tombstones
    where user_id = p_user_id
      and reason = 'deleted'
  ) then
    raise exception using errcode = '55000', message = 'authorized deletion tombstone is missing';
  end if;

  return v_request;
end;
$$;

create or replace function public.authorize_account_deletion(
  p_user_id uuid,
  p_request_id uuid,
  p_receipt_secret_hash text,
  p_google_revocation_handled boolean,
  p_manual_revocation_required boolean
)
returns public.account_deletion_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.account_deletion_requests%rowtype;
  v_authorized_at timestamptz;
begin
  if p_user_id is null or p_request_id is null
    or p_receipt_secret_hash is null
    or p_receipt_secret_hash !~ '^[0-9A-Fa-f]{64}$'
    or p_google_revocation_handled is null
    or p_manual_revocation_required is null then
    raise exception using errcode = '22023', message = 'valid user, request, and receipt hash are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into v_request
  from public.account_deletion_requests
  where user_id = p_user_id
    and request_id = p_request_id
    and receipt_hash = lower(p_receipt_secret_hash)
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'deletion challenge not found';
  end if;
  if v_request.authorized_at is not null then
    return v_request;
  end if;
  if v_request.status <> 'challenged'
    or v_request.expires_at <= clock_timestamp() then
    raise exception using errcode = '22023', message = 'deletion challenge is expired';
  end if;

  perform 1 from auth.users where id = p_user_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'deletion account does not exist';
  end if;
  if exists (
    select 1 from public.deleted_account_tombstones where user_id = p_user_id
  ) then
    raise exception using errcode = '55000', message = 'deletion account is unavailable';
  end if;

  v_authorized_at := clock_timestamp();
  insert into public.deleted_account_tombstones (
    user_id, reason, replacement_user_id, deleted_at, delete_after
  ) values (
    p_user_id, 'deleted', null, v_authorized_at,
    v_authorized_at + interval '90 days'
  );

  update public.account_deletion_requests
  set status = 'authorized',
      authorized_at = v_authorized_at,
      google_revocation_handled_at = case
        when p_google_revocation_handled then v_authorized_at
        else google_revocation_handled_at
      end,
      manual_revocation_required = manual_revocation_required or p_manual_revocation_required,
      attempts = attempts + 1,
      error_code = null,
      updated_at = v_authorized_at
  where id = v_request.id
  returning * into v_request;

  return v_request;
end;
$$;

create or replace function public.mark_account_deletion_phase(
  p_user_id uuid,
  p_request_id uuid,
  p_phase text,
  p_manual_revocation_required boolean
)
returns public.account_deletion_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.account_deletion_requests%rowtype;
begin
  if p_user_id is null or p_request_id is null
    or p_phase is null or p_phase not in ('provider', 'storage')
    or p_manual_revocation_required is null then
    raise exception using errcode = '22023', message = 'valid deletion phase inputs are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into v_request
  from public.account_deletion_requests
  where user_id = p_user_id and request_id = p_request_id
  for update;
  if not found or v_request.authorized_at is null then
    raise exception using errcode = '42501', message = 'authorized deletion request is required';
  end if;
  if v_request.db_cleared_at is not null or v_request.status = 'completed' then
    return v_request;
  end if;

  if p_phase = 'provider' then
    if v_request.provider_revoked_at is not null then
      return v_request;
    end if;

    update public.account_deletion_requests
    set provider_revoked_at = coalesce(provider_revoked_at, clock_timestamp()),
        manual_revocation_required = manual_revocation_required or p_manual_revocation_required,
        status = 'processing',
        error_code = null,
        updated_at = clock_timestamp()
    where id = v_request.id
    returning * into v_request;
  else
    if v_request.storage_cleared_at is not null then
      return v_request;
    end if;
    if exists (
      select 1
      from storage.objects
      where bucket_id = 'personal-media'
        and (storage.foldername(name))[1] = p_user_id::text
    ) then
      raise exception using errcode = '55000', message = 'personal media storage is not empty';
    end if;

    update public.account_deletion_requests
    set storage_cleared_at = coalesce(storage_cleared_at, clock_timestamp()),
        status = 'processing',
        error_code = null,
        updated_at = clock_timestamp()
    where id = v_request.id
    returning * into v_request;
  end if;

  return v_request;
end;
$$;

create or replace function public.finalize_account_deletion(
  p_user_id uuid,
  p_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.account_deletion_requests%rowtype;
  v_group_id uuid;
  v_new_owner_id text;
  v_rejected_owner_ids text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into v_request
  from public.account_deletion_requests
  where user_id = p_user_id and request_id = p_request_id
  for update;
  if not found or v_request.authorized_at is null then
    raise exception using errcode = '42501', message = 'authorized deletion request is required';
  end if;
  if v_request.db_cleared_at is not null then
    return true;
  end if;
  if v_request.provider_revoked_at is null or v_request.storage_cleared_at is null then
    raise exception using errcode = '55000', message = 'provider and storage phases must complete first';
  end if;
  if exists (
    select 1
    from storage.objects
    where bucket_id = 'personal-media'
      and (storage.foldername(name))[1] = p_user_id::text
  ) then
    raise exception using errcode = '55000', message = 'personal media storage is not empty';
  end if;

  -- Every worker locks owned groups in UUID order. A candidate must still
  -- exist in Auth and have no deletion lifecycle row or persistent tombstone.
  for v_group_id in
    select g.id
    from public.groups g
    where g.owner_user_id = p_user_id::text
       or exists (
         select 1 from public.group_members owner_membership
         where owner_membership.group_id = g.id
           and owner_membership.user_id = p_user_id::text
           and owner_membership.is_owner = true
       )
    order by g.id
  loop
    perform pg_advisory_xact_lock(hashtextextended('group:' || v_group_id::text, 0));
    perform 1
    from public.groups g
    where g.id = v_group_id
      and (
        g.owner_user_id = p_user_id::text
        or exists (
          select 1
          from public.group_members owner_membership
          where owner_membership.group_id = g.id
            and owner_membership.user_id = p_user_id::text
            and owner_membership.is_owner = true
        )
      )
    for update;
    if not found then
      continue;
    end if;

    v_rejected_owner_ids := array[p_user_id::text];
    loop
      v_new_owner_id := null;
      select gm.user_id into v_new_owner_id
      from public.group_members gm
      join auth.users au on au.id::text = gm.user_id
      where gm.group_id = v_group_id
        and not (gm.user_id = any(v_rejected_owner_ids))
      order by gm.created_at, gm.user_id
      limit 1
      for update of gm, au;
      if v_new_owner_id is null then
        exit;
      end if;

      -- Re-check in a fresh READ COMMITTED statement after the Auth row lock.
      -- authorize_account_deletion takes that same row lock before freezing.
      if exists (
        select 1 from public.account_deletion_requests
        where user_id::text = v_new_owner_id
          and authorized_at is not null
      ) or exists (
        select 1 from public.deleted_account_tombstones
        where user_id::text = v_new_owner_id
      ) then
        v_rejected_owner_ids := array_append(v_rejected_owner_ids, v_new_owner_id);
        continue;
      end if;
      exit;
    end loop;

    if v_new_owner_id is null then
      -- Delete children before the parent. Migration 003's membership DELETE
      -- trigger updates the parent and must not run during an ON DELETE CASCADE
      -- of that same parent row.
      delete from public.group_members where group_id = v_group_id;
      delete from public.groups where id = v_group_id;
    else
      update public.groups
      set owner_user_id = v_new_owner_id
      where id = v_group_id;
      update public.group_members
      set is_owner = (user_id = v_new_owner_id)
      where group_id = v_group_id;
    end if;
  end loop;

  delete from public.shared_entries where user_id = p_user_id::text;
  delete from public.group_members where user_id = p_user_id::text;
  delete from public.groups g
  where g.last_deleter_user_id = p_user_id::text
    and not exists (
    select 1 from public.group_members gm where gm.group_id = g.id
  );

  update public.groups
  set last_deleter_user_id = null
  where last_deleter_user_id = p_user_id::text;
  delete from public.account_merge_intents
  where target_user_id = p_user_id;
  update public.deleted_account_tombstones
  set replacement_user_id = null
  where replacement_user_id = p_user_id;

  -- provider_revoked_at is required above, so encrypted material is never
  -- discarded before its revocation phase has completed.
  delete from private.apple_credentials where user_id = p_user_id;
  delete from public.sync_mutations where user_id = p_user_id;
  delete from public.personal_calendar_entries where user_id = p_user_id;
  delete from public.personal_special_dates where user_id = p_user_id;
  delete from public.personal_preferences where user_id = p_user_id;
  delete from public.personal_stamps where user_id = p_user_id;
  delete from public.personal_trip_items where user_id = p_user_id;
  delete from public.personal_trips where user_id = p_user_id;
  delete from public.profiles where user_id = p_user_id;

  update public.account_deletion_requests
  set status = 'db-cleared',
      db_cleared_at = clock_timestamp(),
      error_code = null,
      updated_at = clock_timestamp()
  where user_id = p_user_id and request_id = p_request_id;

  return true;
end;
$$;

create or replace function public.complete_account_deletion_receipt(
  p_request_id uuid,
  p_receipt_secret_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.account_deletion_requests%rowtype;
  v_user_id uuid;
  v_status text;
  v_manual_revocation_required boolean;
  v_completed_at timestamptz;
begin
  if p_request_id is null or p_receipt_secret_hash is null
    or p_receipt_secret_hash !~ '^[0-9A-Fa-f]{64}$' then
    raise exception using errcode = '22023', message = 'valid request and receipt hash are required';
  end if;

  select user_id into v_user_id
  from public.account_deletion_requests
  where request_id = p_request_id
    and receipt_hash = lower(p_receipt_secret_hash);
  if not found then
    return null;
  end if;
  if v_user_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  end if;

  select * into v_request
  from public.account_deletion_requests
  where request_id = p_request_id
    and receipt_hash = lower(p_receipt_secret_hash)
  for update;
  if not found then
    return null;
  end if;

  v_status := v_request.status;
  v_manual_revocation_required := v_request.manual_revocation_required;
  if v_request.status = 'completed' then
    return jsonb_build_object(
      'status', v_status,
      'manualRevocationRequired', v_manual_revocation_required
    );
  end if;
  if v_request.db_cleared_at is null then
    raise exception using errcode = '55000', message = 'database deletion phase is incomplete';
  end if;

  -- GoTrue deletion can lag the Edge request. Keep the receipt retryable and
  -- report db-cleared instead of turning that ordinary lag into a 5xx.
  if exists (
    select 1 from auth.users where id = v_request.user_id
  ) then
    return jsonb_build_object(
      'status', v_status,
      'manualRevocationRequired', v_manual_revocation_required
    );
  end if;

  v_completed_at := clock_timestamp();
  update public.account_deletion_requests
  set status = 'completed',
      completed_at = v_completed_at,
      user_id = null,
      error_code = null,
      updated_at = v_completed_at,
      delete_after = v_completed_at + interval '90 days'
  where id = v_request.id
  returning status, manual_revocation_required
    into v_status, v_manual_revocation_required;

  return jsonb_build_object(
    'status', v_status,
    'manualRevocationRequired', v_manual_revocation_required
  );
end;
$$;

create or replace function public.get_account_deletion_status(
  p_request_id uuid,
  p_receipt_secret_hash text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_manual_revocation_required boolean;
begin
  if p_request_id is null or p_receipt_secret_hash is null
    or p_receipt_secret_hash !~ '^[0-9A-Fa-f]{64}$' then
    return null;
  end if;

  select status, manual_revocation_required
    into v_status, v_manual_revocation_required
  from public.account_deletion_requests
  where request_id = p_request_id
    and receipt_hash = lower(p_receipt_secret_hash);
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'status', v_status,
    'manualRevocationRequired', v_manual_revocation_required
  );
end;
$$;

create or replace function public.mark_account_deletion_failed(
  p_user_id uuid,
  p_request_id uuid,
  p_error_code text
)
returns public.account_deletion_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.account_deletion_requests%rowtype;
begin
  if p_user_id is null or p_request_id is null
    or p_error_code is null or char_length(p_error_code) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'invalid error code';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into v_request
  from public.account_deletion_requests
  where request_id = p_request_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'deletion request not found';
  end if;
  if v_request.db_cleared_at is not null or v_request.status = 'completed' then
    return v_request;
  end if;
  if v_request.user_id is distinct from p_user_id
    or v_request.authorized_at is null then
    raise exception using errcode = '42501', message = 'authorized deletion request is required';
  end if;

  update public.account_deletion_requests
  set status = 'failed',
      attempts = attempts + 1,
      error_code = p_error_code,
      updated_at = clock_timestamp()
  where id = v_request.id
  returning * into v_request;
  return v_request;
end;
$$;

create or replace function public.purge_expired_account_lifecycle_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_merge_intents integer := 0;
  v_deletion_receipts integer := 0;
  v_tombstones integer := 0;
  v_limit integer := 500;
begin
  with doomed as (
    select id
    from public.account_merge_intents
    where delete_after <= clock_timestamp()
      and (merged_at is not null or expires_at <= clock_timestamp())
    order by delete_after, id
    limit v_limit
    for update skip locked
  )
  delete from public.account_merge_intents target
  using doomed
  where target.id = doomed.id;
  get diagnostics v_merge_intents = row_count;

  with doomed as (
    select id
    from public.account_deletion_requests
    where delete_after <= clock_timestamp()
      and (
        status = 'completed'
        or (status = 'challenged' and expires_at <= clock_timestamp())
      )
    order by delete_after, id
    limit v_limit
    for update skip locked
  )
  delete from public.account_deletion_requests target
  using doomed
  where target.id = doomed.id;
  get diagnostics v_deletion_receipts = row_count;

  with doomed as (
    select user_id
    from public.deleted_account_tombstones
    where delete_after <= clock_timestamp()
    order by delete_after, user_id
    limit v_limit
    for update skip locked
  )
  delete from public.deleted_account_tombstones target
  using doomed
  where target.user_id = doomed.user_id;
  get diagnostics v_tombstones = row_count;

  return jsonb_build_object(
    'mergeIntents', v_merge_intents,
    'deletionReceipts', v_deletion_receipts,
    'tombstones', v_tombstones
  );
end;
$$;

revoke all on function public.create_account_merge_intent(uuid, text) from public;
revoke all on function public.create_account_merge_intent(uuid, text) from anon;
revoke all on function public.create_account_merge_intent(uuid, text) from authenticated;
grant execute on function public.create_account_merge_intent(uuid, text) to service_role;

revoke all on function public.consume_account_merge_intent(text, uuid) from public;
revoke all on function public.consume_account_merge_intent(text, uuid) from anon;
revoke all on function public.consume_account_merge_intent(text, uuid) from authenticated;
grant execute on function public.consume_account_merge_intent(text, uuid) to service_role;

revoke all on function public.cancel_account_merge_intent(uuid, uuid) from public;
revoke all on function public.cancel_account_merge_intent(uuid, uuid) from anon;
revoke all on function public.cancel_account_merge_intent(uuid, uuid) from authenticated;
grant execute on function public.cancel_account_merge_intent(uuid, uuid) to service_role;

revoke all on function public.merge_account_data(uuid, uuid, uuid, boolean) from public;
revoke all on function public.merge_account_data(uuid, uuid, uuid, boolean) from anon;
revoke all on function public.merge_account_data(uuid, uuid, uuid, boolean) from authenticated;
grant execute on function public.merge_account_data(uuid, uuid, uuid, boolean) to service_role;

revoke all on function public.store_apple_credential(uuid, text, text, text) from public;
revoke all on function public.store_apple_credential(uuid, text, text, text) from anon;
revoke all on function public.store_apple_credential(uuid, text, text, text) from authenticated;
grant execute on function public.store_apple_credential(uuid, text, text, text) to service_role;

revoke all on function public.get_apple_credential_for_deletion(uuid) from public;
revoke all on function public.get_apple_credential_for_deletion(uuid) from anon;
revoke all on function public.get_apple_credential_for_deletion(uuid) from authenticated;
grant execute on function public.get_apple_credential_for_deletion(uuid) to service_role;

revoke all on function public.has_apple_credential(uuid, text) from public;
revoke all on function public.has_apple_credential(uuid, text) from anon;
revoke all on function public.has_apple_credential(uuid, text) from authenticated;
grant execute on function public.has_apple_credential(uuid, text) to service_role;

revoke all on function public.create_account_deletion_challenge(uuid, uuid, text) from public;
revoke all on function public.create_account_deletion_challenge(uuid, uuid, text) from anon;
revoke all on function public.create_account_deletion_challenge(uuid, uuid, text) from authenticated;
grant execute on function public.create_account_deletion_challenge(uuid, uuid, text) to service_role;

revoke all on function public.resume_account_deletion(uuid, uuid, text) from public;
revoke all on function public.resume_account_deletion(uuid, uuid, text) from anon;
revoke all on function public.resume_account_deletion(uuid, uuid, text) from authenticated;
grant execute on function public.resume_account_deletion(uuid, uuid, text) to service_role;

revoke all on function public.authorize_account_deletion(uuid, uuid, text, boolean, boolean) from public;
revoke all on function public.authorize_account_deletion(uuid, uuid, text, boolean, boolean) from anon;
revoke all on function public.authorize_account_deletion(uuid, uuid, text, boolean, boolean) from authenticated;
grant execute on function public.authorize_account_deletion(uuid, uuid, text, boolean, boolean) to service_role;

revoke all on function public.mark_account_deletion_phase(uuid, uuid, text, boolean) from public;
revoke all on function public.mark_account_deletion_phase(uuid, uuid, text, boolean) from anon;
revoke all on function public.mark_account_deletion_phase(uuid, uuid, text, boolean) from authenticated;
grant execute on function public.mark_account_deletion_phase(uuid, uuid, text, boolean) to service_role;

revoke all on function public.finalize_account_deletion(uuid, uuid) from public;
revoke all on function public.finalize_account_deletion(uuid, uuid) from anon;
revoke all on function public.finalize_account_deletion(uuid, uuid) from authenticated;
grant execute on function public.finalize_account_deletion(uuid, uuid) to service_role;

revoke all on function public.complete_account_deletion_receipt(uuid, text) from public;
revoke all on function public.complete_account_deletion_receipt(uuid, text) from anon;
revoke all on function public.complete_account_deletion_receipt(uuid, text) from authenticated;
grant execute on function public.complete_account_deletion_receipt(uuid, text) to service_role;

revoke all on function public.get_account_deletion_status(uuid, text) from public;
revoke all on function public.get_account_deletion_status(uuid, text) from anon;
revoke all on function public.get_account_deletion_status(uuid, text) from authenticated;
grant execute on function public.get_account_deletion_status(uuid, text) to service_role;

revoke all on function public.mark_account_deletion_failed(uuid, uuid, text) from public;
revoke all on function public.mark_account_deletion_failed(uuid, uuid, text) from anon;
revoke all on function public.mark_account_deletion_failed(uuid, uuid, text) from authenticated;
grant execute on function public.mark_account_deletion_failed(uuid, uuid, text) to service_role;

revoke all on function public.purge_expired_account_lifecycle_data() from public;
revoke all on function public.purge_expired_account_lifecycle_data() from anon;
revoke all on function public.purge_expired_account_lifecycle_data() from authenticated;
grant execute on function public.purge_expired_account_lifecycle_data() to service_role;

commit;
