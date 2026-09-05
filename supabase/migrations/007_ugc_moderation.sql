-- RECOTO group safety: reporting, blocking, owner removal, and narrow writes.
-- Apply after 006_account_lifecycle.sql.

begin;

create table if not exists public.user_blocks (
  blocker_user_id uuid not null references auth.users (id) on delete cascade,
  blocked_user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key (blocker_user_id, blocked_user_id),
  check (blocker_user_id <> blocked_user_id)
);

create index if not exists user_blocks_blocked_user_id_idx
  on public.user_blocks (blocked_user_id, blocker_user_id);

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  client_report_id uuid not null,
  reporter_user_id uuid references auth.users (id) on delete set null,
  group_id uuid references public.groups (id) on delete set null,
  target_user_id uuid references auth.users (id) on delete set null,
  shared_entry_id uuid references public.shared_entries (id) on delete set null,
  reason text not null check (reason in ('harassment', 'hate', 'sexual', 'violence', 'personal_info', 'spam_fraud', 'copyright', 'other')),
  detail text not null default '' check (char_length(detail) <= 500),
  content_snapshot jsonb not null default '{}'::jsonb check (octet_length(content_snapshot::text) <= 32768),
  status text not null default 'received' check (status in ('received', 'reviewing', 'actioned', 'dismissed')),
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  check (resolved_at is null or status in ('actioned', 'dismissed')),
  unique (reporter_user_id, client_report_id)
);

create index if not exists content_reports_status_created_at_idx
  on public.content_reports (status, created_at);
create index if not exists content_reports_created_at_idx
  on public.content_reports (created_at);
create index if not exists content_reports_target_user_id_created_at_idx
  on public.content_reports (target_user_id, created_at desc)
  where target_user_id is not null;

create table if not exists public.group_bans (
  group_id uuid not null references public.groups (id) on delete cascade,
  banned_user_id uuid not null references auth.users (id) on delete cascade,
  banned_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (group_id, banned_user_id),
  check (banned_by is null or banned_by <> banned_user_id)
);

create index if not exists group_bans_banned_user_id_idx
  on public.group_bans (banned_user_id, group_id);

alter table public.user_blocks enable row level security;
alter table public.user_blocks force row level security;
alter table public.content_reports enable row level security;
alter table public.content_reports force row level security;
alter table public.group_bans enable row level security;
alter table public.group_bans force row level security;

revoke all on table public.user_blocks from public;
revoke all on table public.user_blocks from anon;
revoke all on table public.user_blocks from authenticated;
revoke all on table public.content_reports from public;
revoke all on table public.content_reports from anon;
revoke all on table public.content_reports from authenticated;
revoke all on table public.group_bans from public;
revoke all on table public.group_bans from anon;
revoke all on table public.group_bans from authenticated;

grant select on table public.user_blocks to authenticated;
grant select, insert, update, delete on table public.user_blocks to service_role;
grant select, insert, update, delete on table public.content_reports to service_role;
grant select, insert, update, delete on table public.group_bans to service_role;

drop policy if exists user_blocks_select_own on public.user_blocks;
create policy user_blocks_select_own on public.user_blocks
  for select to authenticated
  using (
    (select public.current_group_identity_is_active())
    and blocker_user_id = (select auth.uid())
  );

-- No authenticated SELECT policy or table grant is created for reports. A
-- reported person must never be able to discover a reporter through PostgREST.

create or replace function public.users_have_block_relation(
  p_viewer_user_id uuid,
  p_other_user_id text
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select p_viewer_user_id = auth.uid()
    and exists (
    select 1
    from public.user_blocks ub
    where (
      ub.blocker_user_id = p_viewer_user_id
      and ub.blocked_user_id::text = p_other_user_id
    ) or (
      ub.blocked_user_id = p_viewer_user_id
      and ub.blocker_user_id::text = p_other_user_id
    )
  );
$$;

revoke all on function public.users_have_block_relation(uuid, text) from public;
revoke all on function public.users_have_block_relation(uuid, text) from anon;
grant execute on function public.users_have_block_relation(uuid, text) to authenticated, service_role;

-- A blocker may still read the minimum member metadata needed to undo their
-- own block. Authored schedules remain hidden in both directions.
create or replace function public.current_user_blocks(p_other_user_id text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select auth.uid() is not null
    and exists (
      select 1 from public.user_blocks ub
      where ub.blocker_user_id = auth.uid()
        and ub.blocked_user_id::text = p_other_user_id
    );
$$;

revoke all on function public.current_user_blocks(text) from public;
revoke all on function public.current_user_blocks(text) from anon;
grant execute on function public.current_user_blocks(text) to authenticated, service_role;

-- Group owners must retain access to member controls even when an abusive
-- member attempts to hide from them by creating a block in the other direction.
-- This helper is used only for member metadata; blocked authored content stays
-- hidden by the shared_entries policy below.
create or replace function public.current_user_owns_group(p_group_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select auth.uid() is not null
    and exists (
      select 1 from public.groups g
      where g.id = p_group_id and g.owner_user_id = auth.uid()::text
    );
$$;

revoke all on function public.current_user_owns_group(uuid) from public;
revoke all on function public.current_user_owns_group(uuid) from anon;
grant execute on function public.current_user_owns_group(uuid) to authenticated, service_role;

-- Text filtering stays intentionally narrow. It rejects executable URI schemes,
-- explicit threats/slurs, and child sexual exploitation terms. Context-sensitive
-- speech is handled through reports instead of a broad false-positive word list.
create or replace function public.assert_safe_shared_text(
  p_value text,
  p_field text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_normalized text;
begin
  if p_value is null or btrim(p_value) = '' then
    return;
  end if;

  v_normalized := lower(normalize(p_value, NFKC));
  v_normalized := translate(
    v_normalized,
    chr(173) || chr(847) || chr(1564) || chr(4447) || chr(4448) ||
      chr(6068) || chr(6069) || chr(6158) ||
      chr(8203) || chr(8204) || chr(8205) || chr(8206) || chr(8207) ||
      chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238) ||
      chr(8288) || chr(8289) || chr(8290) || chr(8291) || chr(8292) ||
      chr(8293) || chr(8294) || chr(8295) || chr(8296) || chr(8297) ||
      chr(8298) || chr(8299) || chr(8300) || chr(8301) || chr(8302) ||
      chr(8303) || chr(65279),
    ''
  );

  if v_normalized ~ '(javascript|vbscript)[[:space:]]*:'
     or v_normalized ~ 'data[[:space:]]*:[[:space:]]*text[[:space:]]*/[[:space:]]*html'
     or v_normalized ~ 'file[[:space:]]*:'
     or v_normalized ~ '死ね([[:space:]。、！？!?]|$)'
     or position('殺すぞ' in v_normalized) > 0
     or position('殺してやる' in v_normalized) > 0
     or v_normalized ~ '\m(kill[[:space:]]+yourself|i[[:space:]]+will[[:space:]]+kill[[:space:]]+you)\M'
     or v_normalized ~ '\m(child[[:space:]]+porn(ography)?|underage[[:space:]]+sex)\M'
     or position('児童ポルノ' in v_normalized) > 0
     or v_normalized ~ '\m(nigg(er|a)|faggot)\M'
  then
    raise exception 'unsafe_shared_content'
      using errcode = '22023', detail = coalesce(p_field, 'shared_content');
  end if;
end;
$$;

revoke all on function public.assert_safe_shared_text(text, text) from public;
revoke all on function public.assert_safe_shared_text(text, text) from anon;
grant execute on function public.assert_safe_shared_text(text, text) to authenticated, service_role;

-- shared_entries.time_slots is a legacy text column. Validate it as a small,
-- portable JSON array before it can reach another member's UI. Device-only
-- notification identifiers and arbitrary object keys are deliberately rejected.
create or replace function public.assert_valid_shared_time_slots(
  p_value text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_slots jsonb;
  v_slot jsonb;
  v_url text;
begin
  if p_value is null or btrim(p_value) = '' then
    return;
  end if;
  if octet_length(p_value) > 65536 then
    raise exception 'invalid_shared_time_slots' using errcode = '22023';
  end if;

  begin
    v_slots := p_value::jsonb;
  exception when others then
    raise exception 'invalid_shared_time_slots' using errcode = '22023';
  end;

  if jsonb_typeof(v_slots) <> 'array'
     or jsonb_array_length(v_slots) > 96 then
    raise exception 'invalid_shared_time_slots' using errcode = '22023';
  end if;

  for v_slot in select value from jsonb_array_elements(v_slots)
  loop
    if jsonb_typeof(v_slot) <> 'object'
       or exists (
         select 1
         from jsonb_object_keys(v_slot) as keys(key_name)
         where lower(key_name) not in (
           'id', 'starttime', 'endtime', 'title', 'color', 'url',
           'notificationenabled', 'reflecttomonthly'
         )
       )
       or jsonb_typeof(v_slot -> 'id') <> 'string'
       or octet_length(v_slot ->> 'id') not between 1 and 200
       or jsonb_typeof(v_slot -> 'startTime') <> 'string'
       or (v_slot ->> 'startTime') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or jsonb_typeof(v_slot -> 'endTime') <> 'string'
       or (v_slot ->> 'endTime') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or jsonb_typeof(v_slot -> 'title') <> 'string'
       or octet_length(v_slot ->> 'title') > 500
       or jsonb_typeof(v_slot -> 'color') <> 'string'
       or octet_length(v_slot ->> 'color') not between 1 and 32
       or (v_slot ? 'notificationEnabled'
           and jsonb_typeof(v_slot -> 'notificationEnabled') <> 'boolean')
       or (v_slot ? 'reflectToMonthly'
           and jsonb_typeof(v_slot -> 'reflectToMonthly') <> 'boolean') then
      raise exception 'invalid_shared_time_slots' using errcode = '22023';
    end if;

    if v_slot ? 'url' then
      if jsonb_typeof(v_slot -> 'url') <> 'string' then
        raise exception 'invalid_shared_time_slots' using errcode = '22023';
      end if;
      v_url := v_slot ->> 'url';
      if octet_length(v_url) > 2048
         or v_url !~* '^https?://'
         or v_url ~* '^https?://[^/?#]*@'
         or v_url ~ '[[:cntrl:][:space:]]' then
        raise exception 'invalid_shared_time_slots' using errcode = '22023';
      end if;
      perform public.assert_safe_shared_text(v_url, 'time_slot_url');
    end if;

    perform public.assert_safe_shared_text(v_slot ->> 'title', 'time_slot_title');
  end loop;
end;
$$;

revoke all on function public.assert_valid_shared_time_slots(text) from public;
revoke all on function public.assert_valid_shared_time_slots(text) from anon;
grant execute on function public.assert_valid_shared_time_slots(text) to authenticated, service_role;

create or replace function public.moderate_groups_row()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.assert_safe_shared_text(new.name, 'group_name');
  perform public.assert_safe_shared_text(new.shared_memo, 'shared_memo');
  return new;
end;
$$;

create or replace function public.moderate_group_members_row()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.assert_safe_shared_text(new.user_name, 'user_name');
  return new;
end;
$$;

create or replace function public.moderate_shared_entries_row()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if octet_length(new.notes) > 10000
     or octet_length(new.main_stamp_text) > 500
     or octet_length(new.mini_left_text) > 500
     or octet_length(new.mini_right_text) > 500 then
    raise exception 'shared_entry_content_too_large' using errcode = '22023';
  end if;
  perform public.assert_safe_shared_text(new.user_name, 'user_name');
  perform public.assert_safe_shared_text(new.main_stamp_text, 'main_stamp_text');
  perform public.assert_safe_shared_text(new.mini_left_text, 'mini_left_text');
  perform public.assert_safe_shared_text(new.mini_right_text, 'mini_right_text');
  perform public.assert_safe_shared_text(new.notes, 'notes');
  perform public.assert_valid_shared_time_slots(new.time_slots);
  return new;
end;
$$;

drop trigger if exists groups_moderate_content on public.groups;
create trigger groups_moderate_content
  before insert or update of name, shared_memo on public.groups
  for each row execute procedure public.moderate_groups_row();

drop trigger if exists group_members_moderate_content on public.group_members;
create trigger group_members_moderate_content
  before insert or update of user_name on public.group_members
  for each row execute procedure public.moderate_group_members_row();

drop trigger if exists shared_entries_moderate_content on public.shared_entries;
create trigger shared_entries_moderate_content
  before insert or update of user_name, main_stamp_text, mini_left_text, mini_right_text, notes, time_slots
  on public.shared_entries
  for each row execute procedure public.moderate_shared_entries_row();

drop policy if exists gm_select_member on public.group_members;
drop policy if exists gm_select_visible_member on public.group_members;
create policy gm_select_visible_member on public.group_members
  for select to authenticated
  using (
    public.is_member_of_group(group_id)
    and (
      user_id = (select auth.uid())::text
      or not public.users_have_block_relation((select auth.uid()), user_id)
      or public.current_user_blocks(user_id)
      or public.current_user_owns_group(group_id)
    )
  );

drop policy if exists se_select_member on public.shared_entries;
drop policy if exists se_select_visible_member on public.shared_entries;
create policy se_select_visible_member on public.shared_entries
  for select to authenticated
  using (
    public.is_member_of_group(group_id)
    and (
      user_id = (select auth.uid())::text
      or not public.users_have_block_relation((select auth.uid()), user_id)
    )
  );

-- Shared group data is now changed only through purpose-specific RPCs. Schedule
-- entries remain direct, owner-bound writes under their existing RLS policies.
revoke insert, update, delete on table public.groups from authenticated;
revoke insert, update, delete on table public.group_members from authenticated;
drop policy if exists groups_update_member on public.groups;

create or replace function public.rename_group(
  p_group_id uuid,
  p_name text
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
    raise exception 'not_authenticated';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if not public.current_group_identity_is_active() then
    raise exception 'group_access_denied';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || p_group_id::text, 0));
  if p_name is null or char_length(btrim(p_name)) < 1 or char_length(p_name) > 200 then
    raise exception 'invalid_group_name';
  end if;
  if not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = auth.uid()::text
  ) then
    raise exception 'group_access_denied';
  end if;
  if exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id <> auth.uid()::text
      and public.users_have_block_relation(auth.uid(), gm.user_id)
  ) then
    raise exception 'group_interaction_blocked';
  end if;

  perform public.assert_safe_shared_text(p_name, 'group_name');
  update public.groups set name = btrim(p_name), updated_at = clock_timestamp()
  where id = p_group_id returning * into v_group;
  if not found then raise exception 'group_not_found'; end if;
  return v_group;
end;
$$;

create or replace function public.update_group_memo(
  p_group_id uuid,
  p_memo text
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
    raise exception 'not_authenticated';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if not public.current_group_identity_is_active() then
    raise exception 'group_access_denied';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || p_group_id::text, 0));
  if octet_length(coalesce(p_memo, '')) > 1048576 then
    raise exception 'shared_memo_too_large';
  end if;
  if not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = auth.uid()::text
  ) then
    raise exception 'group_access_denied';
  end if;
  if exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id <> auth.uid()::text
      and public.users_have_block_relation(auth.uid(), gm.user_id)
  ) then
    raise exception 'group_interaction_blocked';
  end if;

  perform public.assert_safe_shared_text(p_memo, 'shared_memo');
  update public.groups set shared_memo = coalesce(p_memo, ''), updated_at = clock_timestamp()
  where id = p_group_id returning * into v_group;
  if not found then raise exception 'group_not_found'; end if;
  return v_group;
end;
$$;

create or replace function public.block_group_user(
  p_group_id uuid,
  p_blocked_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if not public.current_group_identity_is_active() then raise exception 'group_access_denied'; end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || p_group_id::text, 0));
  if p_blocked_user_id is null or p_blocked_user_id = auth.uid() then
    raise exception 'cannot_block_self';
  end if;
  if not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = auth.uid()::text
  ) or not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = p_blocked_user_id::text
  ) then
    raise exception 'group_access_denied';
  end if;

  insert into public.user_blocks (blocker_user_id, blocked_user_id)
  values (auth.uid(), p_blocked_user_id)
  on conflict (blocker_user_id, blocked_user_id) do nothing;
end;
$$;

create or replace function public.unblock_user(
  p_blocked_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if not public.current_group_identity_is_active() then raise exception 'group_access_denied'; end if;
  delete from public.user_blocks
  where blocker_user_id = auth.uid() and blocked_user_id = p_blocked_user_id;
end;
$$;

create or replace function public.report_group_content(
  p_group_id uuid,
  p_target_user_id uuid,
  p_shared_entry_id uuid,
  p_reason text,
  p_detail text,
  p_client_report_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.content_reports%rowtype;
  v_snapshot jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if not public.current_group_identity_is_active() then raise exception 'group_access_denied'; end if;
  if p_client_report_id is null then raise exception 'invalid_report_id'; end if;

  -- A lost response can be retried after the target leaves or the daily limit
  -- is reached. Return the original receipt instead of creating a duplicate.
  select * into v_report
  from public.content_reports
  where reporter_user_id = auth.uid()
    and client_report_id = p_client_report_id;
  if found then
    return jsonb_build_object('status', 'received', 'reportId', v_report.id::text);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('group:' || p_group_id::text, 0));
  if p_target_user_id is null or p_target_user_id = auth.uid() then
    raise exception 'cannot_report_self';
  end if;
  if p_reason is null
    or p_reason not in ('harassment', 'hate', 'sexual', 'violence', 'personal_info', 'spam_fraud', 'copyright', 'other') then
    raise exception 'invalid_report_reason';
  end if;
  if char_length(coalesce(p_detail, '')) > 500 then raise exception 'report_detail_too_long'; end if;
  if not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = auth.uid()::text
  ) or not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = p_target_user_id::text
  ) then
    raise exception 'group_access_denied';
  end if;

  if (
    select count(*) from public.content_reports cr
    where cr.reporter_user_id = auth.uid()
      and cr.created_at > clock_timestamp() - interval '24 hours'
  ) >= 20 then
    raise exception 'report_rate_limited';
  end if;

  if p_shared_entry_id is not null then
    select jsonb_build_object(
      'kind', 'shared_entry',
      'date', se.date,
      'userName', left(se.user_name, 120),
      'mainStampText', left(coalesce(se.main_stamp_text, ''), 200),
      'miniLeftText', left(coalesce(se.mini_left_text, ''), 200),
      'miniRightText', left(coalesce(se.mini_right_text, ''), 200),
      'notes', left(coalesce(se.notes, ''), 2000),
      'timeSlots', left(coalesce(se.time_slots, ''), 2000)
    ) into v_snapshot
    from public.shared_entries se
    where se.id = p_shared_entry_id
      and se.group_id = p_group_id
      and se.user_id = p_target_user_id::text;
    if not found then raise exception 'reported_content_not_found'; end if;
  else
    select jsonb_build_object('kind', 'member', 'userName', left(gm.user_name, 120))
    into v_snapshot
    from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = p_target_user_id::text;
  end if;

  insert into public.content_reports (
    client_report_id, reporter_user_id, group_id, target_user_id,
    shared_entry_id, reason, detail, content_snapshot
  ) values (
    p_client_report_id, auth.uid(), p_group_id, p_target_user_id,
    p_shared_entry_id, p_reason, btrim(coalesce(p_detail, '')), coalesce(v_snapshot, '{}'::jsonb)
  )
  on conflict (reporter_user_id, client_report_id) do update
    set client_report_id = excluded.client_report_id
  returning * into v_report;

  return jsonb_build_object('status', 'received', 'reportId', v_report.id::text);
end;
$$;

create or replace function public.remove_and_ban_group_member(
  p_group_id uuid,
  p_member_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if not public.current_group_identity_is_active() then raise exception 'group_access_denied'; end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || p_group_id::text, 0));
  if p_member_user_id = auth.uid() then raise exception 'cannot_remove_self'; end if;

  perform 1 from public.groups g where g.id = p_group_id for update;
  if not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()::text
      and gm.is_owner = true
  ) then
    raise exception 'owner_required';
  end if;
  if not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = p_member_user_id::text
  ) then
    raise exception 'member_not_found';
  end if;

  insert into public.group_bans (group_id, banned_user_id, banned_by)
  values (p_group_id, p_member_user_id, auth.uid())
  on conflict (group_id, banned_user_id) do update
    set banned_by = excluded.banned_by, created_at = clock_timestamp();

  delete from public.shared_entries
  where group_id = p_group_id and user_id = p_member_user_id::text;
  delete from public.group_members
  where group_id = p_group_id and user_id = p_member_user_id::text;
end;
$$;

create or replace function public.leave_group(
  p_group_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was_owner boolean;
  v_next_owner text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if not public.current_group_identity_is_active() then raise exception 'group_access_denied'; end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || p_group_id::text, 0));
  perform 1 from public.groups g where g.id = p_group_id for update;

  select gm.is_owner into v_was_owner
  from public.group_members gm
  where gm.group_id = p_group_id and gm.user_id = auth.uid()::text
  for update;
  if not found then raise exception 'group_access_denied'; end if;

  delete from public.shared_entries where group_id = p_group_id and user_id = auth.uid()::text;
  delete from public.group_members where group_id = p_group_id and user_id = auth.uid()::text;

  if not exists (select 1 from public.group_members gm where gm.group_id = p_group_id) then
    delete from public.groups where id = p_group_id;
    return;
  end if;

  if v_was_owner then
    select gm.user_id into v_next_owner
    from public.group_members gm
    where gm.group_id = p_group_id
    order by gm.created_at, gm.id
    limit 1
    for update;
    update public.group_members set is_owner = true
    where group_id = p_group_id and user_id = v_next_owner;
    update public.groups set owner_user_id = v_next_owner, updated_at = clock_timestamp()
    where id = p_group_id;
  end if;
end;
$$;

-- Override the latest invite RPC so bans and either direction of a user block
-- are checked inside the same privileged operation used to add membership.
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
  g public.groups%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if not public.current_group_identity_is_active() then raise exception 'group_access_denied'; end if;
  if p_invite is null or char_length(btrim(p_invite)) < 1 or char_length(p_invite) > 32 then
    raise exception 'invalid_invite';
  end if;
  if p_user_name is not null and char_length(p_user_name) > 120 then raise exception 'invalid_user_name'; end if;
  if p_color is null or char_length(p_color) not between 1 and 32 then raise exception 'invalid_color'; end if;
  perform public.assert_safe_shared_text(p_user_name, 'user_name');

  select * into g from public.groups
  where invite_code = upper(btrim(p_invite))
  limit 1;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || g.id::text, 0));

  if exists (
    select 1 from public.group_bans gb
    where gb.group_id = g.id and gb.banned_user_id = auth.uid()
  ) or exists (
    select 1 from public.group_members gm
    where gm.group_id = g.id
      and public.users_have_block_relation(auth.uid(), gm.user_id)
  ) then
    raise exception 'group_access_denied';
  end if;

  if exists (
    select 1 from public.group_members gm
    where gm.group_id = g.id and gm.user_id = auth.uid()::text
  ) then
    return g;
  end if;

  insert into public.group_members (group_id, user_id, user_name, color, is_owner)
  values (g.id, auth.uid()::text, coalesce(btrim(p_user_name), ''), p_color, false);
  return g;
end;
$$;

-- Run daily with the service role. Work is deliberately bounded so a large
-- queue never creates a long blocking transaction; repeat until it returns 0.
create or replace function public.purge_expired_content_reports()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  with doomed as (
    select cr.id
    from public.content_reports cr
    where cr.created_at < clock_timestamp() - interval '180 days'
    order by cr.created_at, cr.id
    limit 500
    for update skip locked
  )
  delete from public.content_reports target
  using doomed
  where target.id = doomed.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_expired_content_reports() from public;
revoke all on function public.purge_expired_content_reports() from anon;
revoke all on function public.purge_expired_content_reports() from authenticated;
grant execute on function public.purge_expired_content_reports() to service_role;

-- Migration 006 completes a guest-to-account merge by updating merged_at.
-- Keep moderation relationships attached to the surviving identity before the
-- source Auth user is deleted (which would otherwise cascade blocks and bans).
create or replace function public.transfer_merged_moderation_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.merged_at is not null
    or new.merged_at is null
    or new.target_user_id is null then
    return new;
  end if;

  -- Preserve both outgoing and incoming blocks. Relations between the two
  -- identities collapse away because the survivor cannot block itself.
  insert into public.user_blocks (
    blocker_user_id, blocked_user_id, created_at
  )
  select new.target_user_id, blocked_user_id, created_at
  from public.user_blocks
  where blocker_user_id = new.source_user_id
    and blocked_user_id <> new.target_user_id
  on conflict (blocker_user_id, blocked_user_id) do nothing;

  insert into public.user_blocks (
    blocker_user_id, blocked_user_id, created_at
  )
  select blocker_user_id, new.target_user_id, created_at
  from public.user_blocks
  where blocked_user_id = new.source_user_id
    and blocker_user_id <> new.target_user_id
  on conflict (blocker_user_id, blocked_user_id) do nothing;

  delete from public.user_blocks
  where blocker_user_id = new.source_user_id
    or blocked_user_id = new.source_user_id;

  -- A group ban follows the account being merged. If the surviving identity
  -- was the moderator, anonymize banned_by to avoid a self-reference.
  insert into public.group_bans (
    group_id, banned_user_id, banned_by, created_at
  )
  select group_id,
    new.target_user_id,
    case
      when banned_by in (new.source_user_id, new.target_user_id) then null
      else banned_by
    end,
    created_at
  from public.group_bans
  where banned_user_id = new.source_user_id
  on conflict (group_id, banned_user_id) do nothing;

  delete from public.group_bans
  where banned_user_id = new.source_user_id;

  update public.group_bans
  set banned_by = case
    when banned_user_id = new.target_user_id then null
    else new.target_user_id
  end
  where banned_by = new.source_user_id;

  -- Keep evidence while avoiding self-reports and the unlikely case where the
  -- two identities generated the same idempotency key.
  update public.content_reports as source_report
  set reporter_user_id = null
  where source_report.reporter_user_id = new.source_user_id
    and (
      source_report.target_user_id = new.target_user_id
      or exists (
        select 1
        from public.content_reports as target_report
        where target_report.reporter_user_id = new.target_user_id
          and target_report.client_report_id = source_report.client_report_id
      )
    );

  update public.content_reports
  set reporter_user_id = new.target_user_id
  where reporter_user_id = new.source_user_id;

  update public.content_reports
  set target_user_id = case
    when reporter_user_id = new.target_user_id then null
    else new.target_user_id
  end
  where target_user_id = new.source_user_id;

  return new;
end;
$$;

revoke all on function public.transfer_merged_moderation_identity() from public;
revoke all on function public.transfer_merged_moderation_identity() from anon;
revoke all on function public.transfer_merged_moderation_identity() from authenticated;

drop trigger if exists account_merge_transfer_moderation
  on public.account_merge_intents;
create trigger account_merge_transfer_moderation
after update of merged_at on public.account_merge_intents
for each row
when (old.merged_at is null and new.merged_at is not null)
execute function public.transfer_merged_moderation_identity();

revoke all on function public.rename_group(uuid, text) from public;
revoke all on function public.rename_group(uuid, text) from anon;
grant execute on function public.rename_group(uuid, text) to authenticated;

revoke all on function public.update_group_memo(uuid, text) from public;
revoke all on function public.update_group_memo(uuid, text) from anon;
grant execute on function public.update_group_memo(uuid, text) to authenticated;

revoke all on function public.block_group_user(uuid, uuid) from public;
revoke all on function public.block_group_user(uuid, uuid) from anon;
grant execute on function public.block_group_user(uuid, uuid) to authenticated;

revoke all on function public.unblock_user(uuid) from public;
revoke all on function public.unblock_user(uuid) from anon;
grant execute on function public.unblock_user(uuid) to authenticated;

revoke all on function public.report_group_content(uuid, uuid, uuid, text, text, uuid) from public;
revoke all on function public.report_group_content(uuid, uuid, uuid, text, text, uuid) from anon;
grant execute on function public.report_group_content(uuid, uuid, uuid, text, text, uuid) to authenticated;

revoke all on function public.remove_and_ban_group_member(uuid, uuid) from public;
revoke all on function public.remove_and_ban_group_member(uuid, uuid) from anon;
grant execute on function public.remove_and_ban_group_member(uuid, uuid) to authenticated;

revoke all on function public.leave_group(uuid) from public;
revoke all on function public.leave_group(uuid) from anon;
grant execute on function public.leave_group(uuid) to authenticated;

revoke all on function public.join_group_by_invite(text, text, text) from public;
revoke all on function public.join_group_by_invite(text, text, text) from anon;
grant execute on function public.join_group_by_invite(text, text, text) to authenticated;

commit;
