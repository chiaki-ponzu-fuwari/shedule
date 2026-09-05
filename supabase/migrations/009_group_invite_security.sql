-- RECOTO group invite hardening.
-- Apply after 008_apple_account_events.sql. Existing short invite codes are
-- intentionally rotated because keeping them active would preserve the
-- brute-forceable path this migration closes.

begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
alter extension pgcrypto set schema extensions;
create schema if not exists private;

create or replace function private.generate_group_invite_code()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select pg_catalog.upper(pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'));
$$;

revoke all on function private.generate_group_invite_code() from public;
revoke all on function private.generate_group_invite_code() from anon;
revoke all on function private.generate_group_invite_code() from authenticated;

alter table public.groups drop constraint if exists groups_invite_code_check;

-- The historical owner-only trigger quite correctly rejects an unauthenticated
-- migration process. Disable only that trigger for the one-time rotation.
alter table public.groups disable trigger groups_owner_invite_code;
update public.groups
set invite_code = private.generate_group_invite_code();
alter table public.groups enable trigger groups_owner_invite_code;

alter table public.groups
  add constraint groups_invite_code_check
  check (char_length(invite_code) = 32 and invite_code ~ '^[A-F0-9]{32}$');

create table if not exists private.group_invite_rate_limits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  window_started_at timestamptz not null default clock_timestamp(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz not null default clock_timestamp()
);

revoke all on table private.group_invite_rate_limits from public;
revoke all on table private.group_invite_rate_limits from anon;
revoke all on table private.group_invite_rate_limits from authenticated;
revoke all on table private.group_invite_rate_limits from service_role;

create or replace function private.consume_group_invite_attempt(
  p_user_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_attempt_count integer;
begin
  if p_user_id is null or p_user_id is distinct from auth.uid() then
    return false;
  end if;

  insert into private.group_invite_rate_limits (
    user_id, window_started_at, attempt_count, last_attempt_at
  ) values (
    p_user_id, clock_timestamp(), 1, clock_timestamp()
  )
  on conflict (user_id) do update
  set window_started_at = case
        when private.group_invite_rate_limits.window_started_at
          <= clock_timestamp() - interval '15 minutes'
        then clock_timestamp()
        else private.group_invite_rate_limits.window_started_at
      end,
      attempt_count = case
        when private.group_invite_rate_limits.window_started_at
          <= clock_timestamp() - interval '15 minutes'
        then 1
        else private.group_invite_rate_limits.attempt_count + 1
      end,
      last_attempt_at = clock_timestamp()
  returning attempt_count into v_attempt_count;

  return v_attempt_count <= 12;
end;
$$;

revoke all on function private.consume_group_invite_attempt(uuid) from public;
revoke all on function private.consume_group_invite_attempt(uuid) from anon;
revoke all on function private.consume_group_invite_attempt(uuid) from authenticated;

-- This trigger is deliberately below the RPC layer. It therefore also guards
-- service-role guest-to-account merges and cannot be bypassed by adding a
-- membership through a future privileged function.
create or replace function private.enforce_group_membership_safety()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  begin
    v_user_id := new.user_id::uuid;
  exception when invalid_text_representation then
    raise exception 'group_membership_denied';
  end;

  perform pg_advisory_xact_lock(
    hashtextextended('group:' || new.group_id::text, 0)
  );

  if exists (
    select 1
    from public.group_bans gb
    where gb.group_id = new.group_id
      and gb.banned_user_id = v_user_id
  ) or exists (
    select 1
    from public.group_members gm
    join public.user_blocks ub on (
      (ub.blocker_user_id = v_user_id and ub.blocked_user_id::text = gm.user_id)
      or (ub.blocked_user_id = v_user_id and ub.blocker_user_id::text = gm.user_id)
    )
    where gm.group_id = new.group_id
      and gm.user_id <> new.user_id
  ) then
    raise exception 'group_membership_denied';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_group_membership_safety() from public;
revoke all on function private.enforce_group_membership_safety() from anon;
revoke all on function private.enforce_group_membership_safety() from authenticated;

drop trigger if exists group_members_enforce_safety on public.group_members;
create trigger group_members_enforce_safety
before insert or update of group_id, user_id on public.group_members
for each row execute function private.enforce_group_membership_safety();

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
  v_generation_attempt integer := 0;
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

  loop
    v_generation_attempt := v_generation_attempt + 1;
    v_invite := private.generate_group_invite_code();
    begin
      insert into public.groups (
        name, color, emoji, invite_code, shared_memo, owner_user_id
      ) values (
        trim(p_name), p_color, coalesce(p_emoji, ''), v_invite, '', auth.uid()::text
      ) returning * into v_group;
      exit;
    exception when unique_violation then
      if v_generation_attempt >= 5 then raise; end if;
    end;
  end loop;

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
  v_attempt_allowed boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if not public.current_group_identity_is_active() then raise exception 'group_access_denied'; end if;
  if p_user_name is not null and char_length(p_user_name) > 120 then raise exception 'invalid_user_name'; end if;
  if p_color is null or char_length(p_color) not between 1 and 32 then raise exception 'invalid_color'; end if;
  perform public.assert_safe_shared_text(p_user_name, 'user_name');

  v_attempt_allowed := private.consume_group_invite_attempt(auth.uid());
  if not v_attempt_allowed then return null; end if;

  p_invite := upper(btrim(coalesce(p_invite, '')));
  if p_invite !~ '^[A-F0-9]{32}$' then return null; end if;

  select * into v_group
  from public.groups
  where invite_code = p_invite
  limit 1;
  if not found then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group.id::text, 0));
  select * into v_group
  from public.groups
  where id = v_group.id and invite_code = p_invite
  for update;
  if not found then return null; end if;

  if exists (
    select 1 from public.group_bans gb
    where gb.group_id = v_group.id and gb.banned_user_id = auth.uid()
  ) or exists (
    select 1 from public.group_members gm
    where gm.group_id = v_group.id
      and public.users_have_block_relation(auth.uid(), gm.user_id)
  ) then
    return null;
  end if;

  if exists (
    select 1 from public.group_members gm
    where gm.group_id = v_group.id and gm.user_id = auth.uid()::text
  ) then
    return v_group;
  end if;

  if (select count(*) from public.group_members where group_id = v_group.id) >= 50 then
    return null;
  end if;

  insert into public.group_members (group_id, user_id, user_name, color, is_owner)
  values (v_group.id, auth.uid()::text, coalesce(btrim(p_user_name), ''), p_color, false);
  return v_group;
end;
$$;

revoke all on function public.join_group_by_invite(text, text, text) from public;
revoke all on function public.join_group_by_invite(text, text, text) from anon;
revoke all on function public.join_group_by_invite(text, text, text) from authenticated;
grant execute on function public.join_group_by_invite(text, text, text) to authenticated;

create or replace function public.purge_expired_group_invite_rate_limits()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  with expired as (
    select limiter.user_id
    from private.group_invite_rate_limits limiter
    where limiter.last_attempt_at < clock_timestamp() - interval '24 hours'
    order by limiter.last_attempt_at, limiter.user_id
    limit 500
    for update skip locked
  )
  delete from private.group_invite_rate_limits limiter
  using expired
  where limiter.user_id = expired.user_id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_expired_group_invite_rate_limits() from public;
revoke all on function public.purge_expired_group_invite_rate_limits() from anon;
revoke all on function public.purge_expired_group_invite_rate_limits() from authenticated;
grant execute on function public.purge_expired_group_invite_rate_limits() to service_role;

commit;
