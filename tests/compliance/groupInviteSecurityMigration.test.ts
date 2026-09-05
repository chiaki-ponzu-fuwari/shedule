import fs from 'node:fs';
import path from 'node:path';

const MIGRATION = path.resolve(
  __dirname,
  '../../supabase/migrations/009_group_invite_security.sql'
);

function sql(): string {
  return fs.readFileSync(MIGRATION, 'utf8').replace(/--.*$/gm, ' ').replace(/\s+/g, ' ').toLowerCase();
}

function functionBody(source: string, qualifiedName: string): string {
  const start = source.indexOf(`create or replace function ${qualifiedName}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

describe('009 group invite security migration', () => {
  test('generates and rotates cryptographically random 128-bit invite codes', () => {
    const source = sql();
    const generator = functionBody(source, 'private.generate_group_invite_code');
    const createGroup = functionBody(source, 'public.create_group_with_owner');

    expect(source).toContain('create extension if not exists pgcrypto with schema extensions');
    expect(generator).toContain("extensions.gen_random_bytes(16)");
    expect(generator).toContain("encode(");
    expect(generator).not.toContain('md5(');
    expect(generator).not.toContain('random()');
    expect(source).toMatch(/update public\.groups set invite_code = private\.generate_group_invite_code\(\)/);
    expect(source).toMatch(/check \(char_length\(invite_code\) = 32 and invite_code ~ '\^\[a-f0-9\]\{32\}\$'\)/);
    expect(createGroup).toContain('private.generate_group_invite_code()');
    expect(createGroup).not.toContain('md5(');
  });

  test('rate-limits every lookup and gives all denied joins the same null result', () => {
    const source = sql();
    const join = functionBody(source, 'public.join_group_by_invite');
    const consume = functionBody(source, 'private.consume_group_invite_attempt');

    expect(source).toContain('create table if not exists private.group_invite_rate_limits');
    expect(source).toContain('references auth.users (id) on delete cascade');
    expect(consume).toContain("interval '15 minutes'");
    expect(consume).toContain('attempt_count + 1');
    expect(join.indexOf('private.consume_group_invite_attempt(auth.uid())')).toBeLessThan(
      join.indexOf('from public.groups')
    );
    expect(join).toContain('if not v_attempt_allowed then return null');
    expect(join).toContain("p_invite !~ '^[a-f0-9]{32}$'");
    const inviteLookup = join.indexOf('from public.groups');
    expect(join.slice(inviteLookup)).not.toContain("raise exception 'group_access_denied'");
  });

  test('caps membership and enforces bans and blocks for every membership insertion', () => {
    const source = sql();
    const join = functionBody(source, 'public.join_group_by_invite');
    const guard = functionBody(source, 'private.enforce_group_membership_safety');

    expect(join).toMatch(/count\(\*\).*?>= 50/);
    expect(guard).toContain("hashtextextended('group:' || new.group_id::text, 0)");
    expect(guard).toContain('from public.group_bans');
    expect(guard).toContain('join public.user_blocks');
    expect(guard).toContain("raise exception 'group_membership_denied'");
    expect(source).toMatch(
      /create trigger group_members_enforce_safety before insert or update of group_id, user_id on public\.group_members/
    );
  });

  test('keeps helper functions and limiter rows inaccessible to app roles', () => {
    const source = sql();

    expect(source).toContain('revoke all on table private.group_invite_rate_limits from public');
    expect(source).toContain('revoke all on table private.group_invite_rate_limits from anon');
    expect(source).toContain('revoke all on table private.group_invite_rate_limits from authenticated');
    for (const fn of [
      'private.generate_group_invite_code()',
      'private.consume_group_invite_attempt(uuid)',
      'private.enforce_group_membership_safety()',
    ]) {
      expect(source).toContain(`revoke all on function ${fn} from public`);
      expect(source).toContain(`revoke all on function ${fn} from anon`);
      expect(source).toContain(`revoke all on function ${fn} from authenticated`);
    }
  });

  test('purges expired limiter metadata with a bounded service-only job', () => {
    const source = sql();
    const purge = functionBody(source, 'public.purge_expired_group_invite_rate_limits');

    expect(purge).toContain("interval '24 hours'");
    expect(purge).toContain('limit 500');
    expect(purge).toContain('for update skip locked');
    expect(source).toContain(
      'revoke all on function public.purge_expired_group_invite_rate_limits() from authenticated'
    );
    expect(source).toContain(
      'grant execute on function public.purge_expired_group_invite_rate_limits() to service_role'
    );
  });
});
