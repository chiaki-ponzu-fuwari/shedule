import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(ROOT, 'supabase/migrations');

function readMigration(fileName: string): string {
  return fs.readFileSync(path.join(MIGRATIONS, fileName), 'utf8');
}

function normalized(sql: string): string {
  return sql.replace(/--.*$/gm, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function expectNoPublicFunctionGrant(sql: string): void {
  expect(normalized(sql)).not.toMatch(
    /grant execute on function [^;]+ to (?:public|anon)(?:\s*;|\s*,)/
  );
}

function functionDefinition(sql: string, functionName: string): string {
  const qualifiedName = functionName.includes('.') ? functionName : `public.${functionName}`;
  const start = sql.indexOf(`create or replace function ${qualifiedName}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + 3);
}

function tableDefinition(sql: string, tableName: string, schema = 'public'): string {
  const match = sql.match(
    new RegExp(`create table if not exists ${schema}\\.${tableName} \\((.*?)\\);`, 's')
  );
  expect(match?.[1]).toBeDefined();
  return match?.[1] ?? '';
}

describe('Supabase migration contracts', () => {
  test('000 recreates the group schema consumed by the existing stores', () => {
    const sql = normalized(readMigration('000_group_base_schema.sql'));

    for (const table of ['groups', 'group_members', 'shared_entries']) {
      expect(sql).toContain(`create table if not exists public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toMatch(new RegExp(`revoke all on table public\\.${table} from public`));
      expect(sql).toMatch(new RegExp(`revoke all on table public\\.${table} from anon`));
      expect(sql).toMatch(new RegExp(`revoke all on table public\\.${table} from authenticated`));
      expect(sql).toMatch(
        new RegExp(`grant select, insert, update, delete on table public\\.${table} to authenticated`)
      );
    }

    for (const column of [
      'invite_code',
      'shared_memo',
      'owner_user_id',
      'last_deleter_user_id',
      'user_name',
      'is_owner',
      'main_stamp_text',
      'main_stamp_bg',
      'main_stamp_text_color',
      'mini_left_text',
      'mini_left_bg',
      'mini_right_text',
      'mini_right_bg',
      'time_slots',
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${column}\\b`));
    }

    expect(sql).toMatch(/unique\s*\(\s*group_id\s*,\s*user_id\s*\)/);
    expect(sql).toMatch(/unique\s*\(\s*group_id\s*,\s*user_id\s*,\s*date\s*\)/);
    expect(sql).toMatch(/create index if not exists group_members_user_id_group_id_idx/);
    expect(sql).toMatch(/create index if not exists shared_entries_group_id_date_idx/);
    expect(sql).toMatch(/create index if not exists groups_owner_user_id_idx/);
    expect(sql).toMatch(/create index if not exists groups_last_deleter_user_id_idx/);
  });

  test('005 gives every personal table an indexed cascading auth owner and RLS', () => {
    const sql = normalized(readMigration('005_personal_cloud.sql'));
    const tables = [
      'profiles',
      'personal_calendar_entries',
      'personal_special_dates',
      'personal_preferences',
      'personal_stamps',
      'personal_trips',
      'personal_trip_items',
      'sync_mutations',
    ];

    for (const table of tables) {
      expect(sql).toContain(`create table if not exists public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`alter table public.${table} force row level security`);
      expect(sql).toMatch(
        new RegExp(
          `create table if not exists public\\.${table} \\(.*?user_id uuid[^;]*?references auth\\.users \\(id\\) on delete cascade`,
          's'
        )
      );
      expect(sql).toMatch(
        new RegExp(
          `(?:user_id uuid[^,]*primary key|primary key \\(user_id(?:,|\\))|create (?:unique )?index if not exists ${table}_user_id(?:_[a-z_]+)?_idx on public\\.${table} \\(user_id(?:,|\\)))`
        )
      );
      expect(sql).toContain(`revoke all on table public.${table} from public`);
      expect(sql).toContain(`revoke all on table public.${table} from anon`);
      expect(sql).toMatch(
        new RegExp(
          `create policy ${table}_owner_access on public\\.${table}.*?\\(select auth\\.uid\\(\\)\\) = user_id`,
          's'
        )
      );
    }

    expectNoPublicFunctionGrant(sql);
  });

  test('005 sync rows carry version, revision, timestamps, and tombstones', () => {
    const sql = normalized(readMigration('005_personal_cloud.sql'));
    const syncTables = [
      'personal_calendar_entries',
      'personal_special_dates',
      'personal_preferences',
      'personal_stamps',
      'personal_trips',
      'personal_trip_items',
      'sync_mutations',
    ];

    for (const table of syncTables) {
      const createStatement = sql.match(
        new RegExp(`create table if not exists public\\.${table} \\((.*?)\\);`, 's')
      )?.[1];
      expect(createStatement).toBeDefined();
      expect(createStatement).toMatch(/schema_version smallint not null default 1/);
      expect(createStatement).toMatch(/revision bigint not null default 1/);
      expect(createStatement).toMatch(/created_at timestamptz not null default now\(\)/);
      expect(createStatement).toMatch(/updated_at timestamptz not null default now\(\)/);
      expect(createStatement).toMatch(/deleted_at timestamptz/);
    }
  });

  test('005 uses a monotonic change cursor instead of treating row revisions as an owner cursor', () => {
    const sql = normalized(readMigration('005_personal_cloud.sql'));
    const pullTables = [
      'personal_calendar_entries',
      'personal_special_dates',
      'personal_preferences',
      'personal_stamps',
      'personal_trips',
      'personal_trip_items',
    ];

    expect(sql).toContain('create sequence if not exists public.personal_change_sequence');
    for (const table of pullTables) {
      const createStatement = sql.match(
        new RegExp(`create table if not exists public\\.${table} \\((.*?)\\);`, 's')
      )?.[1];
      expect(createStatement).toMatch(
        /change_sequence bigint not null default nextval\('public\.personal_change_sequence'::regclass\)/
      );
      expect(sql).toMatch(
        new RegExp(
          `create index if not exists ${table}_user_id_change_sequence_idx on public\\.${table} \\(user_id, change_sequence`
        )
      );
      expect(sql).toMatch(
        new RegExp(
          `create trigger ${table}_set_updated_at before update on public\\.${table}[\\s\\S]*?set_personal_updated_at\\(\\)`
        )
      );
    }
    expect(sql).toMatch(
      /new\.change_sequence := nextval\('public\.personal_change_sequence'::regclass\)/
    );
  });

  test('005 stores trips and trip items with an owner-safe cascading parent relation', () => {
    const sql = normalized(readMigration('005_personal_cloud.sql'));
    const tripItems = tableDefinition(sql, 'personal_trip_items');
    const mutations = tableDefinition(sql, 'sync_mutations');
    const rpc = functionDefinition(sql, 'apply_personal_mutations');

    expect(tripItems).toMatch(/trip_id text/);
    expect(tripItems).toMatch(
      /foreign key \(user_id, trip_id\) references public\.personal_trips \(user_id, entity_id\) on delete cascade/
    );
    expect(tripItems).toMatch(
      /payload is null or \(trip_id is not null and coalesce\(payload ->> 'tripid', ''\) = trip_id\)/
    );
    expect(sql).toMatch(
      /create index if not exists personal_trip_items_user_id_trip_id_idx on public\.personal_trip_items \(user_id, trip_id\)/
    );
    expect(mutations).toContain(
      "entity in ('calendar-entry', 'special-date', 'preference', 'stamp', 'trip', 'trip-item')"
    );
    expect(rpc).toMatch(
      /v_entity not in \(\s*'calendar-entry', 'special-date', 'preference', 'stamp', 'trip', 'trip-item'\s*\)/
    );
    expect(rpc).toContain("elsif v_entity = 'trip' then");
    expect(rpc).toContain("elsif v_entity = 'trip-item' then");
    expect(rpc).toContain("v_payload ->> 'tripid'");
    expect(rpc).toMatch(
      /from public\.personal_trips as parent[\s\S]*?parent\.user_id = v_user_id[\s\S]*?parent\.entity_id = v_trip_id[\s\S]*?parent\.deleted_at is null[\s\S]*?for update/
    );
    expect(rpc).toMatch(/v_payload ->> 'localdate'/);
    expect(rpc).toMatch(/v_payload ->> 'arrivallocaldate'/);
    expect(rpc).toMatch(/v_trip_start_date[\s\S]*?v_trip_end_date/);
    expect(rpc).toMatch(/trip item date is outside the active trip period/);
    expect(rpc).toMatch(
      /if v_entity = 'trip' and v_operation = 'upsert' then[\s\S]*?invalid trip period/
    );
    expect(rpc).toMatch(
      /for v_child in[\s\S]*?from public\.personal_trip_items as child[\s\S]*?child\.user_id = v_user_id[\s\S]*?child\.trip_id = v_entity_id[\s\S]*?child\.deleted_at is null[\s\S]*?for update/
    );
    expect(rpc).toMatch(/active trip item date is outside the updated trip period/);
    expect(rpc).toMatch(
      /if v_applied and v_operation = 'delete' then[\s\S]*?update public\.personal_trip_items as child[\s\S]*?payload = null[\s\S]*?deleted_at = now\(\)[\s\S]*?child\.user_id = v_user_id[\s\S]*?child\.trip_id = v_entity_id[\s\S]*?child\.deleted_at is null/
    );
    expect(rpc.indexOf('pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0))'))
      .toBeLessThan(rpc.indexOf('for v_item in select value from jsonb_array_elements'));
    expect(sql).toMatch(
      /create trigger personal_trip_items_set_updated_at[\s\S]*?execute function public\.set_personal_updated_at\(\)/
    );
    expect(sql).toMatch(
      /new\.revision := old\.revision \+ 1[\s\S]*?new\.change_sequence := nextval\('public\.personal_change_sequence'::regclass\)/
    );
    expect(rpc.indexOf('select sm.ack into v_ack')).toBeLessThan(
      rpc.indexOf("if v_entity = 'trip-item' and v_operation = 'upsert' then")
    );
  });

  test('005 accepts only schema version 1 and includes it in pull and acknowledgements', () => {
    const sql = normalized(readMigration('005_personal_cloud.sql'));
    const pull = functionDefinition(sql, 'pull_personal_changes');
    const apply = functionDefinition(sql, 'apply_personal_mutations');

    expect(apply).toMatch(
      /if v_schema_version <> 1 then[\s\S]*?unsupported schema version/
    );
    expect(apply.indexOf('if v_schema_version <> 1 then')).toBeLessThan(
      apply.indexOf('insert into public.sync_mutations')
    );
    expect(pull.match(/schema_version/g)?.length).toBeGreaterThanOrEqual(7);
    expect(pull).toContain("'schemaversion', schema_version");
    expect(apply).toContain("'schemaversion', v_authoritative_schema_version");
  });

  test('005 applies insert-if-absent or CAS and returns durable authoritative acknowledgements', () => {
    const sql = normalized(readMigration('005_personal_cloud.sql'));

    expect(sql).toMatch(/write_policy text not null/);
    expect(sql).toMatch(/base_revision bigint/);
    expect(sql).toMatch(/ack jsonb/);
    expect(sql).toContain("write_policy in ('insert-if-absent', 'compare-and-set')");
    expect(sql).toContain("else 'compare-and-set' end");
    expect(sql.match(/target\.revision = v_base_revision/g)).toHaveLength(6);
    expect(sql.match(/on conflict \(user_id(?:, entity_id)?\) do nothing/g)?.length).toBeGreaterThanOrEqual(6);
    expect(sql).toContain("v_status := 'conflict'");
    expect(sql).toMatch(
      /v_operation = 'upsert' and target\.deleted_at is not null[\s\S]*?v_status := 'conflict'/
    );
    expect(sql).toMatch(/select sm\.ack into v_ack[\s\S]*?v_results := v_results \|\| jsonb_build_array\(v_ack\)/);
    for (const field of [
      'mutationId',
      'ownerId',
      'entity',
      'entityId',
      'status',
      'revision',
      'changeSequence',
      'deletedAt',
      'payload',
    ]) {
      expect(sql).toContain(`'${field.toLowerCase()}',`);
    }
    expect(sql).toMatch(/update public\.sync_mutations[\s\S]*?set ack = v_ack/);
  });

  test('005 derives insert-only versus CAS solely from nullable baseRevision', () => {
    const sql = normalized(readMigration('005_personal_cloud.sql'));
    const rpc = functionDefinition(sql, 'apply_personal_mutations');

    expect(tableDefinition(sql, 'sync_mutations')).toMatch(/base_revision bigint/);
    expect(rpc).toMatch(/v_base_revision := nullif\([\s\S]*?'baserevision'/);
    expect(rpc).toContain(
      "v_write_policy := case when v_base_revision is null then 'insert-if-absent' else 'compare-and-set' end"
    );
    expect(rpc).toContain("if v_write_policy = 'insert-if-absent' then");
    expect(rpc).not.toContain("or v_expected_revision = 0");
    expect(rpc).not.toContain('revision = target.revision + 1');
    expect(rpc.match(/target\.revision = v_base_revision/g)).toHaveLength(6);
  });

  test('005 returns a null authoritative row when CAS targets a missing row', () => {
    const rpc = functionDefinition(
      normalized(readMigration('005_personal_cloud.sql')),
      'apply_personal_mutations'
    );

    expect(rpc).toMatch(
      /'authoritative', case when v_authoritative_revision is null then null else jsonb_build_object/
    );
    expect(rpc).toMatch(
      /'row', case when v_authoritative_revision is null then null else jsonb_build_object/
    );
  });

  test('005 accepts only the canonical preferences entity id', () => {
    const rpc = functionDefinition(
      normalized(readMigration('005_personal_cloud.sql')),
      'apply_personal_mutations'
    );

    expect(rpc).toMatch(
      /if v_entity = 'preference' and v_entity_id <> 'preferences' then[\s\S]*?raise exception/
    );
    expect(rpc.indexOf("v_entity = 'preference' and v_entity_id <> 'preferences'")).toBeLessThan(
      rpc.indexOf('insert into public.sync_mutations')
    );
  });

  test('005 keeps media private and confines objects to the authenticated UID prefix', () => {
    const sql = normalized(readMigration('005_personal_cloud.sql'));

    expect(sql).toMatch(
      /insert into storage\.buckets \(id, name, public[^;]+values \('personal-media', 'personal-media', false/
    );
    expect(sql).toContain("bucket_id = 'personal-media'");
    expect(sql).toMatch(
      /\(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/
    );
    expect(sql).toMatch(/create policy personal_media_read on storage\.objects for select to authenticated/);
    expect(sql).not.toMatch(/create policy personal_media_[^;]+ to anon/);
  });

  test('005 exposes one bounded atomic mutation RPC with a fixed search path', () => {
    const sql = normalized(readMigration('005_personal_cloud.sql'));

    expect(sql).toMatch(
      /create or replace function public\.apply_personal_mutations\(p_mutations jsonb\)/
    );
    expect(sql).toMatch(
      /apply_personal_mutations\(p_mutations jsonb\)[\s\S]*?security definer set search_path = ''/
    );
    expect(sql).toMatch(/jsonb_array_length\(p_mutations\) > 500/);
    expect(sql).toMatch(/auth\.jwt\(\) ->> 'is_anonymous'/);
    expect(sql).toMatch(/from auth\.users where id = v_user_id and coalesce\(is_anonymous, false\) = false/);
    expect(sql).toContain(
      'revoke all on function public.apply_personal_mutations(jsonb) from public'
    );
    expect(sql).toContain(
      'revoke all on function public.apply_personal_mutations(jsonb) from anon'
    );
    expect(sql).toMatch(
      /grant execute on function public\.apply_personal_mutations\(jsonb\) to authenticated, service_role/
    );
    expectNoPublicFunctionGrant(sql);
    expect(sql).not.toMatch(/\bexecute\s+format\s*\(/);
  });

  test('005 rejects a deletion-frozen identity before reading durable mutation receipts', () => {
    const sql = normalized(readMigration('005_personal_cloud.sql'));
    const apply = functionDefinition(sql, 'apply_personal_mutations');
    const ownerLock = apply.indexOf('pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0))');
    const activeGuard = apply.indexOf('public.current_personal_cloud_identity_is_active()');
    const mutationLoop = apply.indexOf('for v_item in select value from jsonb_array_elements');
    const receiptRead = apply.indexOf('from public.sync_mutations as sm');

    expect(ownerLock).toBeGreaterThan(0);
    expect(activeGuard).toBeGreaterThan(ownerLock);
    expect(activeGuard).toBeLessThan(mutationLoop);
    expect(activeGuard).toBeLessThan(receiptRead);
  });

  test('005 pages owner-scoped personal changes through an authenticated read RPC', () => {
    const sql = normalized(readMigration('005_personal_cloud.sql'));
    const active = functionDefinition(sql, 'current_personal_cloud_identity_is_active');
    const pull = functionDefinition(sql, 'pull_personal_changes');

    expect(active).toMatch(/security definer set search_path = ''/);
    expect(active).toContain("auth.jwt() ->> 'is_anonymous'");
    expect(active).toMatch(
      /from auth\.users au[\s\S]*?au\.id = auth\.uid\(\)[\s\S]*?coalesce\(au\.is_anonymous, false\) = false/
    );

    expect(pull).toMatch(
      /p_after_change_sequence bigint default null[\s\S]*?security invoker set search_path = ''/
    );
    expect(pull).toContain('public.current_personal_cloud_identity_is_active()');
    expect(pull).toContain(
      'v_after_change_sequence bigint := coalesce(p_after_change_sequence, 0)'
    );
    for (const table of [
      'personal_calendar_entries',
      'personal_special_dates',
      'personal_preferences',
      'personal_stamps',
      'personal_trips',
      'personal_trip_items',
    ]) {
      expect(pull).toContain(`from public.${table}`);
    }
    expect(pull).toContain("'preference'::text as entity");
    expect(pull).toContain("'preferences'::text as entity_id");
    expect(pull).toContain("'trip'::text as entity");
    expect(pull).toContain("'trip-item'::text as entity");
    expect(pull.match(/union all/g)).toHaveLength(5);
    expect(pull).toMatch(
      /where change_sequence > v_after_change_sequence[\s\S]*?order by change_sequence, entity, entity_id[\s\S]*?limit 500/
    );
    for (const field of ['ownerId', 'entity', 'id', 'revision', 'payload', 'updatedAt', 'deletedAt']) {
      expect(pull).toContain(`'${field.toLowerCase()}',`);
    }
    expect(pull).toMatch(/'cursor', v_cursor::text/);
    expect(sql).toContain(
      'revoke all on function public.pull_personal_changes(bigint) from public'
    );
    expect(sql).toContain(
      'revoke all on function public.pull_personal_changes(bigint) from anon'
    );
    expect(sql).toContain(
      'grant execute on function public.pull_personal_changes(bigint) to authenticated'
    );
  });

  test('006 stores one-use ten-minute merge intents without raw nonces', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));

    expect(sql).toContain('create table if not exists public.account_merge_intents');
    expect(sql).toMatch(/nonce_hash (?:text|bytea) not null/);
    expect(sql).not.toMatch(/(?:^|[, (])nonce (?:text|bytea)/);
    expect(sql).toMatch(/expires_at[^,]+interval '10 minutes'/);
    expect(sql).toMatch(/used_at timestamptz/);
    expect(sql).toMatch(/where used_at is null/);
    expect(sql).toMatch(/used_at = clock_timestamp\(\)[^;]+expires_at > clock_timestamp\(\)/);
  });

  test('006 serializes one active intent per source and never extends its original expiry', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const createIntent = functionDefinition(sql, 'create_account_merge_intent');
    const consumeIntent = functionDefinition(sql, 'consume_account_merge_intent');
    const merge = functionDefinition(sql, 'merge_account_data');

    expect(sql).toMatch(
      /create unique index if not exists account_merge_intents_active_source_idx[\s\S]*?\(source_user_id\)[\s\S]*?where merged_at is null/
    );
    expect(tableDefinition(sql, 'account_merge_intents')).toMatch(/merged_at timestamptz/);
    expect(createIntent).toMatch(/pg_advisory_xact_lock\(hashtextextended\(p_source_user_id::text, 0\)\)/);
    expect(createIntent).toMatch(/delete from public\.account_merge_intents[\s\S]*?merged_at is null[\s\S]*?expires_at <= clock_timestamp\(\)/);
    expect(createIntent).not.toMatch(/used_at is not null or expires_at/);
    expect(consumeIntent).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\(least\(v_source_user_id::text, p_target_user_id::text\), 0\)\)/
    );
    expect(consumeIntent).toMatch(/from public\.account_merge_intents[\s\S]*?for update/);
    expect(merge).toMatch(/from public\.account_merge_intents[\s\S]*?for update/);
    expect(merge).toMatch(/where id = p_intent_id[\s\S]*?source_user_id = p_source_user_id[\s\S]*?target_user_id = p_target_user_id/);
    expect(merge).toMatch(/from auth\.users[\s\S]*?id = p_source_user_id[\s\S]*?for update/);
    expect(merge).toContain('v_intent.used_at is null');
    expect(merge).toContain('expires_at > clock_timestamp()');
    expect(merge).not.toMatch(/used_at >= now\(\) - interval/);
    expect(merge).toMatch(/update public\.account_merge_intents[\s\S]*?merged_at = clock_timestamp\(\)/);
  });

  test('006 creates merge intents only for an existing anonymous source account', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const createIntent = functionDefinition(
      sql,
      'create_account_merge_intent'
    );
    const merge = functionDefinition(sql, 'merge_account_data');

    expect(createIntent).toMatch(
      /from auth\.users[\s\S]*?where id = p_source_user_id[\s\S]*?coalesce\(is_anonymous, false\) = true[\s\S]*?for update/
    );
    expect(createIntent).toContain('source must be an anonymous account');
    expect(merge).toMatch(
      /from auth\.users[\s\S]*?where id = p_source_user_id[\s\S]*?coalesce\(is_anonymous, false\) = true[\s\S]*?for update/
    );
  });

  test('006 makes consume retry-safe for the same nonce and target after used_at', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const intentTable = tableDefinition(sql, 'account_merge_intents');
    const consumeIntent = functionDefinition(
      sql,
      'consume_account_merge_intent'
    );
    const merge = functionDefinition(sql, 'merge_account_data');

    expect(intentTable).not.toMatch(/(?:source|target)_user_id uuid[^,]*references auth\.users/);
    expect(consumeIntent).toMatch(
      /from public\.account_merge_intents[\s\S]*?where nonce_hash = lower\(p_nonce_hash\)[\s\S]*?for update/
    );
    expect(consumeIntent).toMatch(
      /if v_intent\.used_at is not null then[\s\S]*?v_intent\.target_user_id is distinct from p_target_user_id[\s\S]*?raise exception[\s\S]*?if v_intent\.merged_at is not null or v_intent\.expires_at > clock_timestamp\(\) then[\s\S]*?return v_intent/
    );
    expect(consumeIntent).toMatch(
      /update public\.account_merge_intents[\s\S]*?used_at is null[\s\S]*?expires_at > clock_timestamp\(\)/
    );
    expect(merge).toMatch(
      /if v_intent\.merged_at is not null then[\s\S]*?return v_intent\.merge_result[\s\S]*?from auth\.users/
    );
  });

  test('006 merge is target-wins and copies only source rows missing remotely', () => {
    const merge = functionDefinition(
      normalized(readMigration('006_account_lifecycle.sql')),
      'merge_account_data'
    );

    expect(merge).not.toContain('excluded.revision > target.revision');
    expect(merge).not.toContain('insert into public.sync_mutations');
    expect(merge).not.toMatch(/update public\.personal_(?:calendar_entries|special_dates|preferences|stamps|trips|trip_items)/);
    for (const table of [
      'profiles',
      'personal_calendar_entries',
      'personal_special_dates',
      'personal_preferences',
      'personal_stamps',
      'personal_trips',
      'personal_trip_items',
    ]) {
      expect(merge).toMatch(
        new RegExp(`insert into public\\.${table}[\\s\\S]*?on conflict \\([^;]+?\\) do nothing`)
      );
    }
    expect(merge).toMatch(
      /insert into public\.group_members[\s\S]*?select gen_random_uuid\(\), group_id, p_target_user_id::text, user_name, color, false, created_at/
    );
    expect(merge).toMatch(
      /with transferred_groups as \([\s\S]*?update public\.groups[\s\S]*?where owner_user_id = p_source_user_id::text[\s\S]*?returning id[\s\S]*?update public\.group_members[\s\S]*?set is_owner = \(member\.user_id = p_target_user_id::text\)/
    );
  });

  test('006 rewrites only copied strict personal-media keys before source rows move', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const merge = functionDefinition(sql, 'merge_account_data');
    const firstPersonalInsert = merge.indexOf('insert into public.profiles');
    const mediaHold = merge.indexOf("'media-copy-required'");

    expect(sql).toMatch(
      /create or replace function private\.payload_has_personal_media_key\( p_payload jsonb, p_owner_id uuid \)/
    );
    expect(sql).toMatch(
      /create or replace function private\.rewrite_personal_media_keys\( p_payload jsonb, p_source_user_id uuid, p_target_user_id uuid \)/
    );
    expect(sql).toMatch(
      /create or replace function private\.personal_media_copies_exist\( p_payload jsonb, p_source_user_id uuid, p_target_user_id uuid \)/
    );
    expect(sql).toContain("v_parts[2] in ('calendar', 'diary', 'stamp', 'trip')");
    expect(sql).toContain("v_parts[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.jpg$'");
    expect(merge).toContain('p_media_copied boolean');
    expect(merge).toContain('private.payload_has_personal_media_key');
    expect(merge).toContain('source.payload, p_source_user_id');
    expect(merge).toMatch(
      /not coalesce\(p_media_copied, false\)[\s\S]*?not private\.personal_media_copies_exist/
    );
    expect(merge.match(/private\.rewrite_personal_media_keys\(/g)).toHaveLength(6);
    for (const [table, entity] of [
      ['personal_trips', 'trip'],
      ['personal_trip_items', 'trip-item'],
    ] as const) {
      expect(merge).toMatch(
        new RegExp(`'entity', '${entity}'[\\s\\S]*?from public\\.${table} source[\\s\\S]*?private\\.personal_media_copies_exist`)
      );
    }
    expect(mediaHold).toBeGreaterThanOrEqual(0);
    expect(mediaHold).toBeLessThan(firstPersonalInsert);
    expect(merge).toContain("'pendingmedia'");
    expect(sql).toContain(
      'revoke all on function public.merge_account_data(uuid, uuid, uuid, boolean) from authenticated'
    );
  });

  test('006 removes owner-scoped travel rows during merge cleanup and account deletion', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const merge = functionDefinition(sql, 'merge_account_data');
    const finalize = functionDefinition(sql, 'finalize_account_deletion');

    for (const table of ['personal_trip_items', 'personal_trips']) {
      expect(merge).toContain(`delete from public.${table} where user_id = p_source_user_id`);
      expect(finalize).toContain(`delete from public.${table} where user_id = p_user_id`);
    }
    expect(merge.indexOf('delete from public.personal_trip_items')).toBeLessThan(
      merge.indexOf('delete from public.personal_trips')
    );
    expect(finalize.indexOf('delete from public.personal_trip_items')).toBeLessThan(
      finalize.indexOf('delete from public.personal_trips')
    );
  });

  test('006 keeps deletion and Apple credentials service-controlled', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const storeCredential = functionDefinition(sql, 'store_apple_credential');

    expect(sql).toContain('create table if not exists public.account_deletion_requests');
    expect(sql).toContain('create schema if not exists private');
    expect(sql).toContain('create table if not exists private.apple_credentials');
    expect(sql).toMatch(/encrypted_refresh_token bytea not null/);
    expect(sql).not.toMatch(/(?:^|[, (])refresh_token text/);

    for (const table of ['account_merge_intents', 'account_deletion_requests']) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`alter table public.${table} force row level security`);
      expect(sql).toContain(`revoke all on table public.${table} from public`);
      expect(sql).toContain(`revoke all on table public.${table} from anon`);
      expect(sql).toContain(`revoke all on table public.${table} from authenticated`);
    }
    expect(sql).not.toContain('grant select on table public.account_deletion_requests to authenticated');
    expect(sql).toContain('revoke all on table private.apple_credentials from public');
    expect(sql).toContain('revoke all on table private.apple_credentials from anon');
    expect(sql).toContain('revoke all on table private.apple_credentials from authenticated');
    expect(storeCredential).toMatch(
      /pg_advisory_xact_lock[\s\S]*?from auth\.users[\s\S]*?is_anonymous[\s\S]*?for update/
    );
    expect(storeCredential).toContain('from public.account_deletion_requests');
    expect(storeCredential).toContain('from public.deleted_account_tombstones');
  });

  test('006 lets only the service cancel an unused owner-matched merge intent', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const cancel = functionDefinition(sql, 'cancel_account_merge_intent');

    expect(cancel).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\(p_source_user_id::text, 0\)\)/
    );
    expect(cancel).toMatch(
      /from public\.account_merge_intents[\s\S]*?where id = p_intent_id[\s\S]*?for update/
    );
    expect(cancel).toMatch(/source_user_id <> p_source_user_id[\s\S]*?errcode = '42501'/);
    expect(cancel).toMatch(/if v_intent\.used_at is not null then return false/);
    expect(cancel).toMatch(
      /delete from public\.account_merge_intents[\s\S]*?source_user_id = p_source_user_id[\s\S]*?used_at is null/
    );
    expect(sql).toContain(
      'revoke all on function public.cancel_account_merge_intent(uuid, uuid) from authenticated'
    );
    expect(sql).toContain(
      'grant execute on function public.cancel_account_merge_intent(uuid, uuid) to service_role'
    );
  });

  test('006 exposes Apple deletion material only through a service-role fixed-path RPC', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const getter = functionDefinition(sql, 'get_apple_credential_for_deletion');

    expect(getter).toMatch(/security definer set search_path = ''/);
    expect(getter).toContain('from public.account_deletion_requests');
    expect(getter).toMatch(
      /encode\(encrypted_refresh_token, 'base64'\)[\s\S]*?from private\.apple_credentials/
    );
    expect(getter).toContain("'ciphertextbase64'");
    expect(getter).toContain("'encryptionkeyid'");
    expect(getter).toMatch(
      /select \* into v_request[\s\S]*?authorized_at is not null[\s\S]*?if v_request\.provider_revoked_at is not null then[\s\S]*?return null/
    );
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(sql).toContain(
        `revoke all on function public.get_apple_credential_for_deletion(uuid) from ${role}`
      );
    }
    expect(sql).toContain(
      'grant execute on function public.get_apple_credential_for_deletion(uuid) to service_role'
    );
  });

  test('006 exposes only a service-role subject-bound Apple credential status', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const status = functionDefinition(sql, 'has_apple_credential');

    expect(status).toMatch(/security definer set search_path = ''/);
    expect(status).toContain('from private.apple_credentials');
    expect(status).toContain('credential.user_id = p_user_id');
    expect(status).toContain('credential.provider_subject_hash = lower(p_provider_subject_hash)');
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(sql).toContain(
        `revoke all on function public.has_apple_credential(uuid, text) from ${role}`
      );
    }
    expect(sql).toContain(
      'grant execute on function public.has_apple_credential(uuid, text) to service_role'
    );
  });

  test('006 retains deleted UID tombstones for exactly the stale-JWT safety window', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const tombstone = tableDefinition(sql, 'deleted_account_tombstones');
    const authorize = functionDefinition(sql, 'authorize_account_deletion');
    const merge = functionDefinition(sql, 'merge_account_data');

    expect(tombstone).toMatch(/user_id uuid primary key/);
    expect(tombstone).not.toContain('references auth.users');
    expect(tombstone).toMatch(/delete_after timestamptz not null/);
    expect(tombstone).toContain("delete_after = deleted_at + interval '90 days'");
    expect(sql).toContain('deleted_account_tombstones_replacement_user_id_idx');
    expect(authorize).toContain('insert into public.deleted_account_tombstones');
    expect(merge).toContain('insert into public.deleted_account_tombstones');
  });

  test('006 separates non-anonymous personal access from deletion-safe guest group access', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const personalActive = functionDefinition(sql, 'current_personal_cloud_identity_is_active');
    const groupActive = functionDefinition(sql, 'current_group_identity_is_active');

    expect(personalActive).toContain("auth.jwt() ->> 'is_anonymous'");
    expect(personalActive).toContain('coalesce(au.is_anonymous, false) = false');
    expect(groupActive).toContain('from auth.users');
    expect(groupActive).not.toContain("auth.jwt() ->> 'is_anonymous'");
    expect(groupActive).not.toContain('coalesce(au.is_anonymous, false) = false');
    for (const active of [personalActive, groupActive]) {
      expect(active).toContain('from public.deleted_account_tombstones');
      expect(active).toContain('from public.account_deletion_requests');
      expect(active).toContain('authorized_at is not null');
    }

    for (const table of [
      'profiles',
      'personal_calendar_entries',
      'personal_special_dates',
      'personal_preferences',
      'personal_stamps',
      'personal_trips',
      'personal_trip_items',
      'sync_mutations',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `create policy ${table}_active_identity on public\\.${table} as restrictive for all[\\s\\S]*?current_personal_cloud_identity_is_active\\(\\)`
        )
      );
    }

    for (const table of ['groups', 'group_members', 'shared_entries']) {
      expect(sql).toMatch(
        new RegExp(
          `create policy ${table}_active_identity on public\\.${table} as restrictive for all[\\s\\S]*?current_group_identity_is_active\\(\\)`
        )
      );
    }

    for (const policy of [
      'personal_media_read',
      'personal_media_insert',
      'personal_media_update',
      'personal_media_delete',
    ]) {
      expect(sql).toMatch(
        new RegExp(`create policy ${policy}[\\s\\S]*?current_personal_cloud_identity_is_active\\(\\)`)
      );
    }

    for (const fn of ['create_group_with_owner', 'join_group_by_invite', 'is_member_of_group']) {
      const definition = functionDefinition(sql, fn);
      expect(definition).toContain('current_group_identity_is_active()');
      expect(definition).toMatch(/security definer set search_path = ''/);
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^;]+? from anon`));
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^;]+? from authenticated`));
    }
    for (const fn of ['create_group_with_owner', 'join_group_by_invite']) {
      const definition = functionDefinition(sql, fn);
      expect(definition.indexOf('pg_advisory_xact_lock')).toBeLessThan(
        definition.indexOf('current_group_identity_is_active()')
      );
    }

    const groupWriteGuard = functionDefinition(sql, 'private.reject_group_write_during_deletion');
    expect(groupWriteGuard).toContain('current_group_identity_is_active()');
    for (const table of ['groups', 'group_members', 'shared_entries']) {
      expect(sql).toMatch(
        new RegExp(
          `create trigger ${table}_reject_deletion_pending before insert or update or delete on public\\.${table}[\\s\\S]*?private\\.reject_group_write_during_deletion\\(\\)`
        )
      );
    }
  });

  test('006 transfers each owned group only to a locked active Auth member', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const finalize = functionDefinition(sql, 'finalize_account_deletion');

    expect(finalize).toMatch(/for v_group_id in[\s\S]*?order by g\.id[\s\S]*?loop/);
    expect(finalize).toContain("pg_advisory_xact_lock(hashtextextended('group:' || v_group_id::text, 0))");
    expect(finalize).toMatch(
      /from public\.groups g[\s\S]*?where g\.id = v_group_id[\s\S]*?g\.owner_user_id = p_user_id::text[\s\S]*?owner_membership\.is_owner = true[\s\S]*?for update/
    );
    expect(finalize).toMatch(
      /from public\.group_members gm[\s\S]*?join auth\.users au on au\.id::text = gm\.user_id[\s\S]*?order by gm\.created_at, gm\.user_id[\s\S]*?for update of gm, au/
    );
    expect(finalize).toContain('v_rejected_owner_ids text[]');
    expect(finalize).toMatch(
      /not \(gm\.user_id = any\(v_rejected_owner_ids\)\)[\s\S]*?for update of gm, au[\s\S]*?if exists \([\s\S]*?account_deletion_requests[\s\S]*?authorized_at is not null[\s\S]*?or exists \([\s\S]*?deleted_account_tombstones[\s\S]*?v_rejected_owner_ids := array_append/
    );
    expect(finalize).toMatch(
      /if v_new_owner_id is null then[\s\S]*?delete from public\.group_members[\s\S]*?group_id = v_group_id[\s\S]*?delete from public\.groups where id = v_group_id/
    );
    expect(finalize).toMatch(
      /delete from public\.groups g[\s\S]*?g\.last_deleter_user_id = p_user_id::text[\s\S]*?not exists \([\s\S]*?from public\.group_members gm/
    );
    expect(finalize).toMatch(
      /update public\.groups[\s\S]*?set last_deleter_user_id = null[\s\S]*?p_user_id::text/
    );
    expect(finalize).toMatch(
      /delete from public\.account_merge_intents[\s\S]*?target_user_id = p_user_id/
    );
    expect(finalize).toMatch(
      /update public\.deleted_account_tombstones[\s\S]*?replacement_user_id = null[\s\S]*?replacement_user_id = p_user_id/
    );
  });

  test('006 challenges deletion for ten minutes without freezing before authorization', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const requestTable = tableDefinition(sql, 'account_deletion_requests');
    const challenge = functionDefinition(sql, 'create_account_deletion_challenge');
    const authorize = functionDefinition(sql, 'authorize_account_deletion');

    expect(requestTable).toMatch(/user_id uuid/);
    expect(requestTable).not.toMatch(/user_id uuid not null/);
    expect(requestTable).not.toMatch(/user_id uuid[^,]*references auth\.users/);
    expect(requestTable).toMatch(/receipt_hash text not null/);
    expect(requestTable).toMatch(/expires_at timestamptz not null/);
    expect(requestTable).toMatch(/authorized_at timestamptz/);
    expect(requestTable).toMatch(/google_revocation_handled_at timestamptz/);
    expect(challenge).toContain("interval '10 minutes'");
    expect(challenge).not.toContain('insert into public.deleted_account_tombstones');
    expect(sql).not.toContain('create or replace function public.request_account_deletion(');
    expect(authorize).toMatch(
      /from public\.account_deletion_requests[\s\S]*?receipt_hash = lower\(p_receipt_secret_hash\)[\s\S]*?for update/
    );
    expect(authorize).toMatch(
      /if v_request\.authorized_at is not null then[\s\S]*?return v_request/
    );
    expect(authorize).toContain('insert into public.deleted_account_tombstones');
    expect(authorize).toMatch(
      /p_google_revocation_handled boolean[\s\S]*?p_manual_revocation_required boolean/
    );
    expect(authorize).toMatch(
      /google_revocation_handled_at = case[\s\S]*?p_google_revocation_handled[\s\S]*?manual_revocation_required = manual_revocation_required or p_manual_revocation_required/
    );
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(sql).toContain(
        `revoke all on function public.authorize_account_deletion(uuid, uuid, text, boolean, boolean) from ${role}`
      );
    }
    expect(sql).toContain(
      'grant execute on function public.authorize_account_deletion(uuid, uuid, text, boolean, boolean) to service_role'
    );
  });

  test('006 resumes only the same already-authorized deletion receipt', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const resume = functionDefinition(sql, 'resume_account_deletion');

    expect(resume).toMatch(/security definer set search_path = ''/);
    expect(resume).toContain('pg_advisory_xact_lock');
    expect(resume).toMatch(
      /where user_id = p_user_id[\s\S]*?request_id = p_request_id[\s\S]*?receipt_hash = lower\(p_receipt_secret_hash\)[\s\S]*?authorized_at is not null[\s\S]*?for update/
    );
    expect(resume).toMatch(
      /from public\.deleted_account_tombstones[\s\S]*?user_id = p_user_id/
    );
    expect(resume).not.toContain('insert into public.deleted_account_tombstones');
  });

  test('006 records provider and storage phases before database finalization', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const requestTable = tableDefinition(sql, 'account_deletion_requests');
    const phase = functionDefinition(sql, 'mark_account_deletion_phase');
    const finalize = functionDefinition(sql, 'finalize_account_deletion');

    expect(requestTable).toMatch(/provider_revoked_at timestamptz/);
    expect(requestTable).toMatch(/storage_cleared_at timestamptz/);
    expect(requestTable).toMatch(/db_cleared_at timestamptz/);
    expect(requestTable).toMatch(/manual_revocation_required boolean not null/);
    expect(phase).toContain("p_phase not in ('provider', 'storage')");
    expect(phase).not.toContain('manual revocation applies only to the provider phase');
    expect(phase).not.toMatch(
      /set storage_cleared_at = [^;]+manual_revocation_required/
    );
    expect(phase).not.toContain('stored provider credential must be revoked before deletion');
    expect(phase).toMatch(
      /p_phase = 'provider'[\s\S]*?provider_revoked_at = coalesce\(provider_revoked_at, clock_timestamp\(\)\)[\s\S]*?manual_revocation_required = manual_revocation_required or p_manual_revocation_required/
    );
    expect(phase).toContain("bucket_id = 'personal-media'");
    expect(phase).toContain('(storage.foldername(name))[1] = p_user_id::text');
    expect(finalize).toMatch(
      /provider_revoked_at is null or v_request\.storage_cleared_at is null[\s\S]*?raise exception/
    );
    expect(finalize).toMatch(
      /from storage\.objects[\s\S]*?bucket_id = 'personal-media'[\s\S]*?foldername\(name\)\)\[1\] = p_user_id::text/
    );
    expect(finalize).toMatch(/status = 'db-cleared'[\s\S]*?db_cleared_at = clock_timestamp\(\)/);
    expect(finalize).not.toMatch(/status = 'completed'/);
    expect(finalize.indexOf('delete from private.apple_credentials')).toBeGreaterThan(
      finalize.indexOf('provider_revoked_at is null')
    );
  });

  test('006 completes a minimal retained receipt only after Auth deletion', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const complete = functionDefinition(sql, 'complete_account_deletion_receipt');
    const status = functionDefinition(sql, 'get_account_deletion_status');
    const failed = functionDefinition(sql, 'mark_account_deletion_failed');

    expect(complete).toMatch(
      /if exists \([\s\S]*?from auth\.users[\s\S]*?id = v_request\.user_id[\s\S]*?return jsonb_build_object/
    );
    expect(complete).toContain('receipt_hash = lower(p_receipt_secret_hash)');
    expect(complete).toMatch(/status = 'completed'[\s\S]*?user_id = null/);
    expect(complete).toMatch(
      /jsonb_build_object\( 'status', v_status, 'manualrevocationrequired', v_manual_revocation_required \)/
    );
    expect(status).toMatch(
      /where request_id = p_request_id[\s\S]*?receipt_hash = lower\(p_receipt_secret_hash\)/
    );
    expect(status).toMatch(
      /jsonb_build_object\( 'status', v_status, 'manualrevocationrequired', v_manual_revocation_required \)/
    );
    expect(status).not.toContain("'userid'");
    expect(failed).toMatch(
      /if v_request\.db_cleared_at is not null or v_request\.status = 'completed' then[\s\S]*?return v_request/
    );
  });

  test('006 gives lifecycle tombstones and receipts an explicit purge boundary', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const mergeIntents = tableDefinition(sql, 'account_merge_intents');
    const requests = tableDefinition(sql, 'account_deletion_requests');
    const tombstones = tableDefinition(sql, 'deleted_account_tombstones');
    const purge = functionDefinition(sql, 'purge_expired_account_lifecycle_data');

    for (const definition of [mergeIntents, requests, tombstones]) {
      expect(definition).toMatch(/delete_after timestamptz not null/);
    }
    expect(purge).toContain('delete from public.account_merge_intents');
    expect(purge).toContain('delete from public.account_deletion_requests');
    expect(purge).toContain('delete from public.deleted_account_tombstones');
    expect(sql).toContain('account_deletion_requests_delete_after_idx');
    expect(sql).toContain(
      'grant execute on function public.purge_expired_account_lifecycle_data() to service_role'
    );
  });

  test('006 rejects personal writes while deletion is pending, including definer writes', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const tables = [
      'profiles',
      'personal_calendar_entries',
      'personal_special_dates',
      'personal_preferences',
      'personal_stamps',
      'personal_trips',
      'personal_trip_items',
      'sync_mutations',
    ];

    expect(sql).toMatch(
      /create or replace function private\.reject_personal_write_during_deletion\(\)[\s\S]*?security definer set search_path = ''/
    );
    for (const table of tables) {
      expect(sql).toMatch(
        new RegExp(
          `create trigger ${table}_reject_deletion_pending before insert or update or delete on public\\.${table}`
        )
      );
      for (const operation of ['insert', 'update', 'delete']) {
        const policy = sql.match(
          new RegExp(
            `create policy ${table}_deletion_guard_${operation} on public\\.${table} as restrictive for ${operation}.*?;`,
            's'
          )
        );
        expect(policy?.[0]).toContain('current_personal_cloud_identity_is_active()');
        expect(policy?.[0]).not.toContain('from public.account_deletion_requests');
      }
    }
  });

  test('006 lifecycle RPCs are fixed-path, injection-free, and service-role-only', () => {
    const sql = normalized(readMigration('006_account_lifecycle.sql'));
    const functions = [
      'create_account_merge_intent',
      'consume_account_merge_intent',
      'cancel_account_merge_intent',
      'merge_account_data',
      'store_apple_credential',
      'get_apple_credential_for_deletion',
      'create_account_deletion_challenge',
      'resume_account_deletion',
      'authorize_account_deletion',
      'mark_account_deletion_phase',
      'finalize_account_deletion',
      'complete_account_deletion_receipt',
      'get_account_deletion_status',
      'mark_account_deletion_failed',
      'purge_expired_account_lifecycle_data',
    ];

    for (const fn of functions) {
      expect(sql).toMatch(
        new RegExp(`create or replace function public\\.${fn}\\([^;]+?security definer set search_path = ''`, 's')
      );
      expect(sql).toMatch(
        new RegExp(`revoke all on function public\\.${fn}\\([^;]+? from public`)
      );
      expect(sql).toMatch(
        new RegExp(`revoke all on function public\\.${fn}\\([^;]+? from anon`)
      );
      expect(sql).toMatch(
        new RegExp(`revoke all on function public\\.${fn}\\([^;]+? from authenticated`)
      );
      expect(sql).toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\([^;]+? to service_role`)
      );
    }

    expectNoPublicFunctionGrant(sql);
    expect(sql).not.toMatch(/\bexecute\s+format\s*\(/);
  });

  test('008 maps signed Apple subjects once, freezes the UID, and completes through service-only RPCs', () => {
    const sql = normalized(readMigration('008_apple_account_events.sql'));
    const events = tableDefinition(sql, 'apple_account_events', 'private');
    const beginEvent = functionDefinition(sql, 'begin_apple_account_event');
    const completeEvent = functionDefinition(sql, 'complete_apple_account_event');

    expect(events).toMatch(/event_id text primary key/);
    expect(events).toMatch(/provider_subject_hash text not null/);
    expect(events).toMatch(/event_type text not null/);
    expect(events).toMatch(/user_id uuid/);
    expect(events).not.toContain('subject text');
    expect(sql).toContain(
      'create unique index if not exists apple_credentials_provider_subject_hash_uidx',
    );
    expect(sql).toContain('alter table private.apple_account_events enable row level security');
    expect(sql).toContain('alter table private.apple_account_events force row level security');
    expect(beginEvent).toMatch(/security definer set search_path = ''/);
    expect(beginEvent).toContain('pg_advisory_xact_lock');
    expect(beginEvent).toContain("'apple-credential:' || lower(p_provider_subject_hash)");
    expect(beginEvent).toMatch(
      /from private\.apple_credentials[\s\S]*?provider_subject_hash = lower\(p_provider_subject_hash\)/,
    );
    expect(beginEvent).toMatch(
      /from private\.apple_credential_store_claims claim[\s\S]*?provider_subject_hash = lower\(p_provider_subject_hash\)[\s\S]*?exchange_started_at is not null/,
    );
    expect(beginEvent).toMatch(
      /claim\.user_id, claim\.exchange_started_at[\s\S]*?join auth\.users auth_user on auth_user\.id = claim\.user_id[\s\S]*?for update of claim, auth_user/,
    );
    const credentialLock = beginEvent.indexOf(
      "'apple-credential:' || lower(p_provider_subject_hash)",
    );
    const inFlightMapping = beginEvent.indexOf(
      'from private.apple_credential_store_claims claim',
    );
    const unmatchedDecision = beginEvent.indexOf('if v_user_id is null then');
    expect(credentialLock).toBeGreaterThanOrEqual(0);
    expect(inFlightMapping).toBeGreaterThan(credentialLock);
    expect(unmatchedDecision).toBeGreaterThan(inFlightMapping);
    expect(sql).toContain('credential_issued_at timestamptz');
    expect(sql).toContain('credential_bound_at timestamptz');
    expect(beginEvent).toMatch(
      /credential\.credential_bound_at[\s\S]*?into v_user_id, v_credential_bound_at/,
    );
    expect(beginEvent).toMatch(
      /p_event_time < v_credential_bound_at[\s\S]*?status, processed_at[\s\S]*?'ignored'/,
    );
    expect(beginEvent).not.toMatch(/p_event_time < v_credential_issued_at/);
    expect(beginEvent).toMatch(
      /if v_event\.provider_subject_hash <> lower\(p_provider_subject_hash\)[\s\S]*?raise exception/,
    );
    expect(beginEvent).toContain('insert into public.deleted_account_tombstones');
    expect(beginEvent).toContain('insert into public.account_deletion_requests');
    expect(beginEvent).toContain("status, authorized_at, provider_revoked_at");
    expect(completeEvent).toMatch(/security definer set search_path = ''/);
    expect(completeEvent).toMatch(
      /if exists \([\s\S]*?from auth\.users[\s\S]*?raise exception/,
    );
    expect(completeEvent).toMatch(
      /status = 'completed'[\s\S]*?user_id = null[\s\S]*?processed_at = clock_timestamp\(\)/,
    );
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(sql).toContain(`revoke all on table private.apple_account_events from ${role}`);
      expect(sql).toContain(
        `revoke all on function public.begin_apple_account_event(text, text, text, timestamptz, uuid, text) from ${role}`,
      );
      expect(sql).toContain(
        `revoke all on function public.complete_apple_account_event(text, uuid, uuid) from ${role}`,
      );
    }
    expect(sql).toContain(
      'grant execute on function public.begin_apple_account_event(text, text, text, timestamptz, uuid, text) to service_role',
    );
    expect(sql).toContain(
      'grant execute on function public.complete_apple_account_event(text, uuid, uuid) to service_role',
    );
    expect(sql).toContain('create table if not exists private.apple_credential_store_claims');
    const storeClaims = tableDefinition(sql, 'apple_credential_store_claims', 'private');
    const beginStore = functionDefinition(sql, 'begin_apple_credential_store');
    const markExchangeStarted = functionDefinition(sql, 'mark_apple_credential_exchange_started');
    const completeStore = functionDefinition(sql, 'complete_apple_credential_store');
    const reconcileStore = functionDefinition(sql, 'reconcile_apple_credential_store');
    expect(storeClaims).toContain('exchange_started_at timestamptz');
    expect(beginStore).toContain('pg_advisory_xact_lock');
    expect(beginStore).toContain("return 'pending'");
    expect(beginStore).toContain("return 'uncertain'");
    expect(beginStore).toMatch(
      /delete from private\.apple_credential_store_claims[\s\S]*?exchange_started_at is null[\s\S]*?expires_at <= v_now/,
    );
    expect(markExchangeStarted).toMatch(/exchange_started_at = clock_timestamp\(\)/);
    expect(markExchangeStarted).toMatch(/claim_id = p_claim_id[\s\S]*?exchange_started_at is null/);
    expect(completeStore).toContain('p_credential_issued_at timestamptz');
    expect(completeStore).toMatch(/claim_id = p_claim_id[\s\S]*?for update/);
    expect(completeStore).toContain('exchange_started_at is not null');
    expect(completeStore).toContain('credential_issued_at');
    expect(completeStore).toMatch(
      /encryption_key_id, credential_issued_at, credential_bound_at[\s\S]*?p_encryption_key_id, p_credential_issued_at, v_claim\.exchange_started_at/,
    );
    expect(completeStore).not.toContain('do update');
    expect(completeStore.indexOf('from public.account_deletion_requests')).toBeLessThan(
      completeStore.indexOf('insert into private.apple_credentials'),
    );
    expect(reconcileStore).toContain('p_provider_revocation_confirmed boolean');
    expect(reconcileStore).toMatch(
      /p_provider_revocation_confirmed is distinct from true[\s\S]*?raise exception/,
    );
    expect(reconcileStore).toMatch(
      /delete from private\.apple_credential_store_claims[\s\S]*?user_id = p_user_id[\s\S]*?provider_subject_hash = lower\(p_provider_subject_hash\)[\s\S]*?claim_id = p_claim_id[\s\S]*?exchange_started_at is not null/,
    );
    expect(sql).toContain(
      'grant execute on function public.begin_apple_credential_store(uuid, text, uuid) to service_role',
    );
    expect(sql).toContain(
      'grant execute on function public.complete_apple_credential_store(uuid, text, uuid, text, text, timestamptz) to service_role',
    );
    expect(sql).toContain(
      'grant execute on function public.mark_apple_credential_exchange_started(uuid, text, uuid) to service_role',
    );
    expect(sql).toContain(
      'grant execute on function public.reconcile_apple_credential_store(uuid, text, uuid, boolean) to service_role',
    );
    expect(sql).toContain(
      'revoke all on function public.store_apple_credential(uuid, text, text, text) from service_role',
    );
  });

  test('005 revokes authenticated table access before restoring SELECT only', () => {
    const sql = normalized(readMigration('005_personal_cloud.sql'));
    const tables = [
      'profiles',
      'personal_calendar_entries',
      'personal_special_dates',
      'personal_preferences',
      'personal_stamps',
      'personal_trips',
      'personal_trip_items',
      'sync_mutations',
    ];

    for (const table of tables) {
      expect(sql).toContain(`revoke all on table public.${table} from authenticated`);
      expect(sql).toContain(`grant select on table public.${table} to authenticated`);
      expect(sql).not.toMatch(
        new RegExp(`grant (?:insert|update|delete|all)[^;]*on table public\\.${table} to authenticated`)
      );
    }
    expect(sql).toContain(
      'revoke all on function public.apply_personal_mutations(jsonb) from authenticated'
    );
  });
});
