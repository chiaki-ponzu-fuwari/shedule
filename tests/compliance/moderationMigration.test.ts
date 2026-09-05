import fs from 'node:fs';
import path from 'node:path';

const MIGRATION = path.resolve(
  __dirname,
  '../../supabase/migrations/007_ugc_moderation.sql'
);

function sql(): string {
  return fs.readFileSync(MIGRATION, 'utf8').replace(/--.*$/gm, ' ').replace(/\s+/g, ' ').toLowerCase();
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`create or replace function public.${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

describe('007 UGC moderation migration', () => {
  test('creates protected block, report, and group-ban records with useful indexes', () => {
    const source = sql();

    for (const table of ['user_blocks', 'content_reports', 'group_bans']) {
      expect(source).toContain(`create table if not exists public.${table}`);
      expect(source).toContain(`alter table public.${table} enable row level security`);
      expect(source).toContain(`alter table public.${table} force row level security`);
      expect(source).toContain(`revoke all on table public.${table} from public`);
      expect(source).toContain(`revoke all on table public.${table} from anon`);
    }

    expect(source).toContain('user_blocks_blocked_user_id_idx');
    expect(source).toContain('content_reports_status_created_at_idx');
    expect(source).toContain('group_bans_banned_user_id_idx');
    expect(source).toMatch(/check \(blocker_user_id <> blocked_user_id\)/);
    expect(source).toMatch(/reason in \('harassment', 'hate', 'sexual', 'violence', 'personal_info', 'spam_fraud', 'copyright', 'other'\)/);
  });

  test('keeps reports private and only lets a blocker read their own block list', () => {
    const source = sql();

    expect(source).not.toMatch(/grant select[^;]*content_reports[^;]*authenticated/);
    expect(source).toMatch(/create policy user_blocks_select_own[\s\S]*?current_group_identity_is_active[\s\S]*?blocker_user_id = \(select auth\.uid\(\)\)/);
    expect(source).not.toMatch(/create policy content_reports_select_[^;]+to authenticated/);
  });

  test.each([
    'block_group_user',
    'unblock_user',
    'report_group_content',
    'remove_and_ban_group_member',
    'rename_group',
    'update_group_memo',
    'leave_group',
  ])('%s is a fixed-search-path authenticated RPC', (name) => {
    const source = sql();
    const fn = functionBody(source, name);

    expect(fn).toMatch(/security definer set search_path = ''/);
    expect(source).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^;]+ from public`));
    expect(source).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^;]+ from anon`));
    expect(source).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^;]+ to authenticated`));
  });

  test('server-side reads hide both sides of a block relation', () => {
    const source = sql();
    const relation = functionBody(source, 'users_have_block_relation');

    expect(relation).toContain('p_viewer_user_id = auth.uid()');
    expect(relation).toContain('blocker_user_id = p_viewer_user_id');
    expect(relation).toContain('blocked_user_id::text = p_other_user_id');
    expect(relation).toContain('blocked_user_id = p_viewer_user_id');
    expect(relation).toContain('blocker_user_id::text = p_other_user_id');
    expect(source).toMatch(/create policy gm_select_visible_member[\s\S]*?not public\.users_have_block_relation/);
    expect(source).toMatch(/create policy se_select_visible_member[\s\S]*?not public\.users_have_block_relation/);
  });

  test('owners retain member controls while blocked content remains hidden', () => {
    const source = sql();
    const memberPolicyStart = source.indexOf('create policy gm_select_visible_member');
    const entryPolicyStart = source.indexOf('create policy se_select_visible_member');
    const entryPolicyEnd = source.indexOf('revoke insert, update, delete on table public.groups');
    const memberPolicy = source.slice(memberPolicyStart, entryPolicyStart);
    const entryPolicy = source.slice(entryPolicyStart, entryPolicyEnd);

    expect(source).toContain('create or replace function public.current_user_owns_group');
    expect(source).toContain('create or replace function public.current_user_blocks');
    expect(memberPolicy).toContain('public.current_user_blocks(user_id)');
    expect(memberPolicy).toContain('public.current_user_owns_group(group_id)');
    expect(entryPolicy).not.toContain('public.current_user_owns_group(group_id)');
  });

  test('ban and block relations prevent invite-code re-entry', () => {
    const source = sql();
    const join = functionBody(source, 'join_group_by_invite');

    expect(join).toContain('from public.group_bans');
    expect(join).toContain("raise exception 'group_access_denied'");
    expect(join).toContain('public.users_have_block_relation');
  });

  test('owner removal is locked, cannot target self, and atomically bans before deletion', () => {
    const fn = functionBody(sql(), 'remove_and_ban_group_member');

    expect(fn).toContain('for update');
    expect(fn).toContain('is_owner = true');
    expect(fn).toContain("raise exception 'cannot_remove_self'");
    expect(fn.indexOf('insert into public.group_bans')).toBeLessThan(
      fn.indexOf('delete from public.group_members')
    );
  });

  test('shared writes are guarded by a bounded server-side content filter', () => {
    const source = sql();
    const guard = functionBody(source, 'assert_safe_shared_text');
    const timeSlots = functionBody(source, 'assert_valid_shared_time_slots');
    const rowGuard = functionBody(source, 'moderate_shared_entries_row');

    expect(guard).toContain("raise exception 'unsafe_shared_content'");
    expect(source).toContain('create trigger groups_moderate_content');
    expect(source).toContain('create trigger group_members_moderate_content');
    expect(source).toContain('create trigger shared_entries_moderate_content');
    expect(guard).toContain('chr(8234)');
    expect(guard).not.toMatch(/\|kys\)/);
    expect(timeSlots).toContain("jsonb_typeof(v_slots) <> 'array'");
    expect(timeSlots).toContain('jsonb_array_length(v_slots) > 96');
    expect(timeSlots).toContain("v_slot ->> 'starttime'");
    expect(timeSlots).toContain("v_slot ->> 'endtime'");
    expect(timeSlots).toContain("v_url !~* '^https?://'");
    expect(timeSlots).toContain('jsonb_object_keys(v_slot)');
    expect(rowGuard).toContain('assert_valid_shared_time_slots(new.time_slots)');
    expect(rowGuard).toContain('octet_length(new.notes) > 10000');
    expect(rowGuard).toContain('octet_length(new.main_stamp_text) > 500');
  });

  test('blocked parties cannot communicate through group-wide memo or name edits', () => {
    for (const name of ['rename_group', 'update_group_memo']) {
      const fn = functionBody(sql(), name);
      expect(fn).toContain('public.users_have_block_relation(auth.uid(), gm.user_id)');
      expect(fn).toContain("raise exception 'group_interaction_blocked'");
    }
  });

  test('report evidence is byte-bounded and can be purged after the disclosed retention period', () => {
    const source = sql();
    const report = functionBody(source, 'report_group_content');
    const purge = functionBody(source, 'purge_expired_content_reports');

    expect(report).toContain("left(coalesce(se.notes, ''), 2000)");
    expect(report).toContain("left(coalesce(se.time_slots, ''), 2000)");
    expect(purge).toContain("interval '180 days'");
    expect(source).toContain('content_reports_created_at_idx');
    expect(source).toMatch(/revoke all on function public\.purge_expired_content_reports\(\) from authenticated/);
    expect(source).toMatch(/grant execute on function public\.purge_expired_content_reports\(\) to service_role/);
  });

  test('report retries return their durable receipt before rate limiting or membership changes', () => {
    const report = functionBody(sql(), 'report_group_content');
    const receiptLookup = report.indexOf('where reporter_user_id = auth.uid()');
    const receiptReturn = report.indexOf("if found then return jsonb_build_object('status', 'received'");
    const membershipCheck = report.indexOf('where gm.group_id = p_group_id and gm.user_id = auth.uid()::text');
    const rateLimit = report.indexOf("interval '24 hours'");

    expect(receiptLookup).toBeGreaterThan(0);
    expect(receiptReturn).toBeGreaterThan(receiptLookup);
    expect(receiptReturn).toBeLessThan(membershipCheck);
    expect(receiptReturn).toBeLessThan(rateLimit);
  });

  test.each([
    'block_group_user',
    'unblock_user',
    'report_group_content',
    'remove_and_ban_group_member',
    'rename_group',
    'update_group_memo',
    'leave_group',
    'join_group_by_invite',
  ])('%s is serialized against account deletion', (name) => {
    const fn = functionBody(sql(), name);
    expect(fn).toContain('pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0))');
    expect(fn).toContain('public.current_group_identity_is_active()');
  });

  test('transfers moderation relationships when a guest identity is merged', () => {
    const source = sql();
    const fn = functionBody(source, 'transfer_merged_moderation_identity');

    expect(source).toContain('create trigger account_merge_transfer_moderation');
    expect(fn).toContain('new.source_user_id');
    expect(fn).toContain('new.target_user_id');
    expect(fn).toContain('insert into public.user_blocks');
    expect(fn).toContain('insert into public.group_bans');
    expect(fn).toContain('update public.content_reports');
    expect(fn).toContain('delete from public.user_blocks');
  });
});
