-- Run after migrations 000-009 with `supabase test db`.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(23);

insert into auth.users (id, aud, role, email, is_anonymous, created_at, updated_at)
values
  ('70000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ugc-owner@example.invalid', false, now(), now()),
  ('70000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ugc-member@example.invalid', false, now(), now()),
  ('70000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'ugc-outsider@example.invalid', false, now(), now());

insert into public.groups (
  id, name, color, emoji, invite_code, owner_user_id
) values (
  '71000000-0000-4000-8000-000000000001', 'Safety test', '#3B82F6', '', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  '70000000-0000-4000-8000-000000000001'
);

insert into public.group_members (
  id, group_id, user_id, user_name, color, is_owner
) values
  (
    '72000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000001',
    'Owner', '#3B82F6', true
  ),
  (
    '72000000-0000-4000-8000-000000000002',
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002',
    'Member', '#EF4444', false
  );

insert into public.shared_entries (
  id, group_id, user_id, user_name, user_color, date, notes
) values
  (
    '73000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000001',
    'Owner', '#3B82F6', date '2026-09-05', 'Owner entry'
  ),
  (
    '73000000-0000-4000-8000-000000000002',
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002',
    'Member', '#EF4444', date '2026-09-05', 'Member entry'
  );

select extensions.ok(
  not has_table_privilege('authenticated', 'public.content_reports', 'select'),
  'authenticated users cannot select the private report queue'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"70000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false}',
  true
);

select extensions.lives_ok(
  $$select public.report_group_content(
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002',
    '73000000-0000-4000-8000-000000000002',
    'harassment', 'Repeated unwanted contact',
    '74000000-0000-4000-8000-000000000001'
  )$$,
  'a member can report another member entry'
);

reset role;
select extensions.is(
  (select count(*)::bigint from public.content_reports),
  1::bigint,
  'the report and its evidence are stored'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"70000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false}',
  true
);

select extensions.lives_ok(
  $$select public.block_group_user(
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002'
  )$$,
  'a member can block another member'
);
select extensions.is(
  (select count(*)::bigint from public.group_members
    where group_id = '71000000-0000-4000-8000-000000000001'),
  2::bigint,
  'the owner retains both member rows for moderation controls'
);
select extensions.is(
  (select count(*)::bigint from public.shared_entries
    where group_id = '71000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the owner cannot read the blocked member entry'
);
select extensions.throws_ok(
  $$select public.update_group_memo(
    '71000000-0000-4000-8000-000000000001', 'indirect message'
  )$$,
  'P0001', 'group_interaction_blocked',
  'blocked parties cannot communicate through the shared memo'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"70000000-0000-4000-8000-000000000002","role":"authenticated","is_anonymous":false}',
  true
);

select extensions.is(
  (select count(*)::bigint from public.group_members
    where group_id = '71000000-0000-4000-8000-000000000001'),
  1::bigint,
  'a blocked non-owner cannot read the blocker member row'
);
select extensions.is(
  (select count(*)::bigint from public.shared_entries
    where group_id = '71000000-0000-4000-8000-000000000001'),
  1::bigint,
  'a blocked non-owner cannot read the blocker entry'
);
select extensions.throws_ok(
  $$select public.remove_and_ban_group_member(
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000001'
  )$$,
  'P0001', 'owner_required',
  'a regular member cannot remove the owner'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"70000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false}',
  true
);

select extensions.lives_ok(
  $$select public.remove_and_ban_group_member(
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002'
  )$$,
  'the owner can atomically remove and ban a member'
);

reset role;
select extensions.is(
  (select count(*)::bigint from public.group_members
    where group_id = '71000000-0000-4000-8000-000000000001'
      and user_id = '70000000-0000-4000-8000-000000000002'),
  0::bigint,
  'removal deletes the membership'
);
select extensions.is(
  (select count(*)::bigint from public.shared_entries
    where group_id = '71000000-0000-4000-8000-000000000001'
      and user_id = '70000000-0000-4000-8000-000000000002'),
  0::bigint,
  'removal deletes the member shared entries'
);
select extensions.is(
  (select count(*)::bigint from public.group_bans
    where group_id = '71000000-0000-4000-8000-000000000001'
      and banned_user_id = '70000000-0000-4000-8000-000000000002'),
  1::bigint,
  'the ban is recorded before membership deletion'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"70000000-0000-4000-8000-000000000002","role":"authenticated","is_anonymous":false}',
  true
);

select extensions.ok(
  public.join_group_by_invite('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'Member', '#EF4444') is null,
  'a removed member cannot rejoin with the invite code'
);
select extensions.throws_ok(
  $$select public.block_group_user(
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002'
  )$$,
  'P0001', 'cannot_block_self',
  'self-blocking is rejected'
);
select extensions.throws_ok(
  $$select public.report_group_content(
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002', null,
    'other', '', '74000000-0000-4000-8000-000000000002'
  )$$,
  'P0001', 'cannot_report_self',
  'self-reporting is rejected'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"70000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false}',
  true
);
select extensions.throws_ok(
  $$select public.remove_and_ban_group_member(
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000001'
  )$$,
  'P0001', 'cannot_remove_self',
  'an owner cannot remove themself through moderation'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"70000000-0000-4000-8000-000000000003","role":"authenticated","is_anonymous":false}',
  true
);

select extensions.throws_ok(
  $$select public.report_group_content(
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000001', null,
    'other', '', '74000000-0000-4000-8000-000000000003'
  )$$,
  'P0001', 'group_access_denied',
  'an outsider cannot report a group member'
);
select extensions.throws_ok(
  $$select public.block_group_user(
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000001'
  )$$,
  'P0001', 'group_access_denied',
  'an outsider cannot block through an unrelated group'
);
select extensions.throws_ok(
  $$select public.rename_group(
    '71000000-0000-4000-8000-000000000001', 'Unauthorized rename'
  )$$,
  'P0001', 'group_access_denied',
  'an outsider cannot rename a group'
);
select extensions.throws_ok(
  $$select public.update_group_memo(
    '71000000-0000-4000-8000-000000000001', 'Unauthorized memo'
  )$$,
  'P0001', 'group_access_denied',
  'an outsider cannot update a group memo'
);

reset role;
select extensions.is(
  (select status from public.content_reports limit 1),
  'received'::text,
  'a report enters the received moderation queue'
);

select * from extensions.finish();
rollback;
