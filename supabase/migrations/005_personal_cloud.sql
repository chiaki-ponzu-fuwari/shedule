-- Personal backup storage. Local state remains usable without Supabase; these
-- rows are used only after a guest connects a backup identity.

begin;

create sequence if not exists public.personal_change_sequence as bigint;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 120),
  schema_version smallint not null default 1 check (schema_version > 0),
  revision bigint not null default 1 check (revision > 0),
  change_sequence bigint not null default nextval('public.personal_change_sequence'::regclass),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.personal_calendar_entries (
  user_id uuid not null references auth.users (id) on delete cascade,
  entity_id text not null check (char_length(entity_id) between 1 and 500),
  payload jsonb,
  schema_version smallint not null default 1 check (schema_version > 0),
  revision bigint not null default 1 check (revision > 0),
  change_sequence bigint not null default nextval('public.personal_change_sequence'::regclass),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, entity_id),
  check (payload is not null or deleted_at is not null),
  check (payload is null or jsonb_typeof(payload) = 'object')
);

create table if not exists public.personal_special_dates (
  user_id uuid not null references auth.users (id) on delete cascade,
  entity_id text not null check (char_length(entity_id) between 1 and 500),
  payload jsonb,
  schema_version smallint not null default 1 check (schema_version > 0),
  revision bigint not null default 1 check (revision > 0),
  change_sequence bigint not null default nextval('public.personal_change_sequence'::regclass),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, entity_id),
  check (payload is not null or deleted_at is not null),
  check (payload is null or jsonb_typeof(payload) = 'object')
);

create table if not exists public.personal_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb,
  schema_version smallint not null default 1 check (schema_version > 0),
  revision bigint not null default 1 check (revision > 0),
  change_sequence bigint not null default nextval('public.personal_change_sequence'::regclass),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (payload is not null or deleted_at is not null),
  check (payload is null or jsonb_typeof(payload) = 'object')
);

create table if not exists public.personal_stamps (
  user_id uuid not null references auth.users (id) on delete cascade,
  entity_id text not null check (char_length(entity_id) between 1 and 500),
  payload jsonb,
  schema_version smallint not null default 1 check (schema_version > 0),
  revision bigint not null default 1 check (revision > 0),
  change_sequence bigint not null default nextval('public.personal_change_sequence'::regclass),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, entity_id),
  check (payload is not null or deleted_at is not null),
  check (payload is null or jsonb_typeof(payload) = 'object')
);

create table if not exists public.personal_trips (
  user_id uuid not null references auth.users (id) on delete cascade,
  entity_id text not null check (char_length(entity_id) between 1 and 500),
  payload jsonb,
  schema_version smallint not null default 1 check (schema_version > 0),
  revision bigint not null default 1 check (revision > 0),
  change_sequence bigint not null default nextval('public.personal_change_sequence'::regclass),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, entity_id),
  check (payload is not null or deleted_at is not null),
  check (payload is null or jsonb_typeof(payload) = 'object')
);

create table if not exists public.personal_trip_items (
  user_id uuid not null references auth.users (id) on delete cascade,
  entity_id text not null check (char_length(entity_id) between 1 and 500),
  -- A delete for a row not present on this server still needs a tombstone, so
  -- its parent key may be null only while payload is null.
  trip_id text check (trip_id is null or char_length(trip_id) between 1 and 500),
  payload jsonb,
  schema_version smallint not null default 1 check (schema_version > 0),
  revision bigint not null default 1 check (revision > 0),
  change_sequence bigint not null default nextval('public.personal_change_sequence'::regclass),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, entity_id),
  foreign key (user_id, trip_id)
    references public.personal_trips (user_id, entity_id) on delete cascade,
  check (payload is not null or deleted_at is not null),
  check (payload is null or jsonb_typeof(payload) = 'object'),
  check (
    payload is null
    or (trip_id is not null and coalesce(payload ->> 'tripId', '') = trip_id)
  )
);

create table if not exists public.sync_mutations (
  user_id uuid not null references auth.users (id) on delete cascade,
  mutation_id text not null check (char_length(mutation_id) between 1 and 200),
  entity text not null check (
    entity in ('calendar-entry', 'special-date', 'preference', 'stamp', 'trip', 'trip-item')
  ),
  entity_id text not null check (char_length(entity_id) between 1 and 500),
  operation text not null check (operation in ('upsert', 'delete')),
  write_policy text not null check (write_policy in ('insert-if-absent', 'compare-and-set')),
  base_revision bigint check (base_revision is null or base_revision >= 0),
  payload jsonb,
  status text check (status is null or status in ('applied', 'conflict')),
  ack jsonb,
  client_created_at timestamptz,
  schema_version smallint not null default 1 check (schema_version > 0),
  revision bigint not null default 1 check (revision > 0),
  change_sequence bigint not null default nextval('public.personal_change_sequence'::regclass),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, mutation_id),
  check (payload is null or jsonb_typeof(payload) = 'object')
);

-- Primary-key prefixes cover the owner lookup on every entity table. The
-- following indexes match the incremental-pull and tombstone cleanup queries.
create index if not exists personal_calendar_entries_user_id_updated_at_idx
  on public.personal_calendar_entries (user_id, updated_at, entity_id);
create index if not exists personal_calendar_entries_user_id_change_sequence_idx
  on public.personal_calendar_entries (user_id, change_sequence, entity_id);
create index if not exists personal_calendar_entries_user_id_deleted_at_idx
  on public.personal_calendar_entries (user_id, deleted_at)
  where deleted_at is not null;
create index if not exists personal_special_dates_user_id_updated_at_idx
  on public.personal_special_dates (user_id, updated_at, entity_id);
create index if not exists personal_special_dates_user_id_change_sequence_idx
  on public.personal_special_dates (user_id, change_sequence, entity_id);
create index if not exists personal_special_dates_user_id_deleted_at_idx
  on public.personal_special_dates (user_id, deleted_at)
  where deleted_at is not null;
create index if not exists personal_preferences_user_id_updated_at_idx
  on public.personal_preferences (user_id, updated_at);
create index if not exists personal_preferences_user_id_change_sequence_idx
  on public.personal_preferences (user_id, change_sequence);
create index if not exists personal_preferences_user_id_deleted_at_idx
  on public.personal_preferences (user_id, deleted_at)
  where deleted_at is not null;
create index if not exists personal_stamps_user_id_updated_at_idx
  on public.personal_stamps (user_id, updated_at, entity_id);
create index if not exists personal_stamps_user_id_change_sequence_idx
  on public.personal_stamps (user_id, change_sequence, entity_id);
create index if not exists personal_stamps_user_id_deleted_at_idx
  on public.personal_stamps (user_id, deleted_at)
  where deleted_at is not null;
create index if not exists personal_trips_user_id_updated_at_idx
  on public.personal_trips (user_id, updated_at, entity_id);
create index if not exists personal_trips_user_id_change_sequence_idx
  on public.personal_trips (user_id, change_sequence, entity_id);
create index if not exists personal_trips_user_id_deleted_at_idx
  on public.personal_trips (user_id, deleted_at)
  where deleted_at is not null;
create index if not exists personal_trip_items_user_id_updated_at_idx
  on public.personal_trip_items (user_id, updated_at, entity_id);
create index if not exists personal_trip_items_user_id_change_sequence_idx
  on public.personal_trip_items (user_id, change_sequence, entity_id);
create index if not exists personal_trip_items_user_id_deleted_at_idx
  on public.personal_trip_items (user_id, deleted_at)
  where deleted_at is not null;
create index if not exists personal_trip_items_user_id_trip_id_idx
  on public.personal_trip_items (user_id, trip_id);
create index if not exists sync_mutations_user_id_created_at_idx
  on public.sync_mutations (user_id, created_at, mutation_id);

-- Migration 006 replaces this helper with the deletion-aware definition.
-- Defining the identity-only form here lets authenticated read RPCs remain
-- SECURITY INVOKER while still checking auth.users without granting clients
-- direct access to the auth schema.
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
      select 1
      from auth.users au
      where au.id = auth.uid()
        and coalesce(au.is_anonymous, false) = false
    );
$$;

revoke all on function public.current_personal_cloud_identity_is_active() from public;
revoke all on function public.current_personal_cloud_identity_is_active() from anon;
revoke all on function public.current_personal_cloud_identity_is_active() from authenticated;
grant execute on function public.current_personal_cloud_identity_is_active() to authenticated;

create or replace function public.set_personal_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.revision := old.revision + 1;
    new.change_sequence := nextval('public.personal_change_sequence'::regclass);
  end if;
  return new;
end;
$$;

revoke all on function public.set_personal_updated_at() from public;
revoke all on function public.set_personal_updated_at() from anon;
revoke all on function public.set_personal_updated_at() from authenticated;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_personal_updated_at();
drop trigger if exists personal_calendar_entries_set_updated_at on public.personal_calendar_entries;
create trigger personal_calendar_entries_set_updated_at
  before update on public.personal_calendar_entries
  for each row execute function public.set_personal_updated_at();
drop trigger if exists personal_special_dates_set_updated_at on public.personal_special_dates;
create trigger personal_special_dates_set_updated_at
  before update on public.personal_special_dates
  for each row execute function public.set_personal_updated_at();
drop trigger if exists personal_preferences_set_updated_at on public.personal_preferences;
create trigger personal_preferences_set_updated_at
  before update on public.personal_preferences
  for each row execute function public.set_personal_updated_at();
drop trigger if exists personal_stamps_set_updated_at on public.personal_stamps;
create trigger personal_stamps_set_updated_at
  before update on public.personal_stamps
  for each row execute function public.set_personal_updated_at();
drop trigger if exists personal_trips_set_updated_at on public.personal_trips;
create trigger personal_trips_set_updated_at
  before update on public.personal_trips
  for each row execute function public.set_personal_updated_at();
drop trigger if exists personal_trip_items_set_updated_at on public.personal_trip_items;
create trigger personal_trip_items_set_updated_at
  before update on public.personal_trip_items
  for each row execute function public.set_personal_updated_at();
drop trigger if exists sync_mutations_set_updated_at on public.sync_mutations;
create trigger sync_mutations_set_updated_at
  before update on public.sync_mutations
  for each row execute function public.set_personal_updated_at();

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.personal_calendar_entries enable row level security;
alter table public.personal_calendar_entries force row level security;
alter table public.personal_special_dates enable row level security;
alter table public.personal_special_dates force row level security;
alter table public.personal_preferences enable row level security;
alter table public.personal_preferences force row level security;
alter table public.personal_stamps enable row level security;
alter table public.personal_stamps force row level security;
alter table public.personal_trips enable row level security;
alter table public.personal_trips force row level security;
alter table public.personal_trip_items enable row level security;
alter table public.personal_trip_items force row level security;
alter table public.sync_mutations enable row level security;
alter table public.sync_mutations force row level security;

drop policy if exists profiles_owner_access on public.profiles;
create policy profiles_owner_access on public.profiles
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists personal_calendar_entries_owner_access on public.personal_calendar_entries;
create policy personal_calendar_entries_owner_access on public.personal_calendar_entries
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists personal_special_dates_owner_access on public.personal_special_dates;
create policy personal_special_dates_owner_access on public.personal_special_dates
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists personal_preferences_owner_access on public.personal_preferences;
create policy personal_preferences_owner_access on public.personal_preferences
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists personal_stamps_owner_access on public.personal_stamps;
create policy personal_stamps_owner_access on public.personal_stamps
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists personal_trips_owner_access on public.personal_trips;
create policy personal_trips_owner_access on public.personal_trips
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists personal_trip_items_owner_access on public.personal_trip_items;
create policy personal_trip_items_owner_access on public.personal_trip_items
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists sync_mutations_owner_access on public.sync_mutations;
create policy sync_mutations_owner_access on public.sync_mutations
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.profiles from public;
revoke all on table public.profiles from anon;
revoke all on table public.profiles from authenticated;
revoke all on table public.personal_calendar_entries from public;
revoke all on table public.personal_calendar_entries from anon;
revoke all on table public.personal_calendar_entries from authenticated;
revoke all on table public.personal_special_dates from public;
revoke all on table public.personal_special_dates from anon;
revoke all on table public.personal_special_dates from authenticated;
revoke all on table public.personal_preferences from public;
revoke all on table public.personal_preferences from anon;
revoke all on table public.personal_preferences from authenticated;
revoke all on table public.personal_stamps from public;
revoke all on table public.personal_stamps from anon;
revoke all on table public.personal_stamps from authenticated;
revoke all on table public.personal_trips from public;
revoke all on table public.personal_trips from anon;
revoke all on table public.personal_trips from authenticated;
revoke all on table public.personal_trip_items from public;
revoke all on table public.personal_trip_items from anon;
revoke all on table public.personal_trip_items from authenticated;
revoke all on table public.sync_mutations from public;
revoke all on table public.sync_mutations from anon;
revoke all on table public.sync_mutations from authenticated;
revoke all on sequence public.personal_change_sequence from public;
revoke all on sequence public.personal_change_sequence from anon;
revoke all on sequence public.personal_change_sequence from authenticated;

grant select on table public.profiles to authenticated;
grant usage on sequence public.personal_change_sequence to service_role;
grant select on table public.personal_calendar_entries to authenticated;
grant select on table public.personal_special_dates to authenticated;
grant select on table public.personal_preferences to authenticated;
grant select on table public.personal_stamps to authenticated;
grant select on table public.personal_trips to authenticated;
grant select on table public.personal_trip_items to authenticated;
grant select on table public.sync_mutations to authenticated;
grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.personal_calendar_entries to service_role;
grant select, insert, update, delete on table public.personal_special_dates to service_role;
grant select, insert, update, delete on table public.personal_preferences to service_role;
grant select, insert, update, delete on table public.personal_stamps to service_role;
grant select, insert, update, delete on table public.personal_trips to service_role;
grant select, insert, update, delete on table public.personal_trip_items to service_role;
grant select, insert, update, delete on table public.sync_mutations to service_role;

-- A fixed-size page keeps one RPC bounded. The cursor is serialized as text so
-- JavaScript clients never lose bigint precision and can treat it as opaque.
create or replace function public.pull_personal_changes(
  p_after_change_sequence bigint default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_after_change_sequence bigint := coalesce(p_after_change_sequence, 0);
  v_rows jsonb;
  v_cursor bigint;
begin
  if not public.current_personal_cloud_identity_is_active() then
    raise exception using errcode = '42501', message = 'personal cloud access is unavailable';
  end if;
  if v_after_change_sequence < 0 then
    raise exception using errcode = '22023', message = 'change cursor cannot be negative';
  end if;

  with all_changes as (
    select
      user_id,
      'calendar-entry'::text as entity,
      entity_id,
      revision,
      payload,
      schema_version,
      change_sequence,
      updated_at,
      deleted_at
    from public.personal_calendar_entries
    where user_id = v_user_id
    union all
    select
      user_id,
      'special-date'::text as entity,
      entity_id,
      revision,
      payload,
      schema_version,
      change_sequence,
      updated_at,
      deleted_at
    from public.personal_special_dates
    where user_id = v_user_id
    union all
    select
      user_id,
      'preference'::text as entity,
      'preferences'::text as entity_id,
      revision,
      payload,
      schema_version,
      change_sequence,
      updated_at,
      deleted_at
    from public.personal_preferences
    where user_id = v_user_id
    union all
    select
      user_id,
      'stamp'::text as entity,
      entity_id,
      revision,
      payload,
      schema_version,
      change_sequence,
      updated_at,
      deleted_at
    from public.personal_stamps
    where user_id = v_user_id
    union all
    select
      user_id,
      'trip'::text as entity,
      entity_id,
      revision,
      payload,
      schema_version,
      change_sequence,
      updated_at,
      deleted_at
    from public.personal_trips
    where user_id = v_user_id
    union all
    select
      user_id,
      'trip-item'::text as entity,
      entity_id,
      revision,
      payload,
      schema_version,
      change_sequence,
      updated_at,
      deleted_at
    from public.personal_trip_items
    where user_id = v_user_id
  ), page as (
    select *
    from all_changes
    where change_sequence > v_after_change_sequence
    order by change_sequence, entity, entity_id
    limit 500
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'ownerId', user_id,
          'entity', entity,
          'id', entity_id,
          'revision', revision,
          'payload', payload,
          'schemaVersion', schema_version,
          'updatedAt', updated_at,
          'deletedAt', deleted_at
        ) order by change_sequence, entity, entity_id
      ),
      '[]'::jsonb
    ),
    coalesce(max(change_sequence), v_after_change_sequence)
  into v_rows, v_cursor
  from page;

  return jsonb_build_object(
    'rows', v_rows,
    'cursor', v_cursor::text
  );
end;
$$;

revoke all on function public.pull_personal_changes(bigint) from public;
revoke all on function public.pull_personal_changes(bigint) from anon;
revoke all on function public.pull_personal_changes(bigint) from authenticated;
grant execute on function public.pull_personal_changes(bigint) to authenticated;

-- Atomically de-duplicate and apply one bounded batch. Entity names are mapped
-- through explicit branches; no table or column name is ever accepted as SQL.
create or replace function public.apply_personal_mutations(p_mutations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_item jsonb;
  v_mutation_id text;
  v_owner_id text;
  v_entity text;
  v_entity_id text;
  v_operation text;
  v_write_policy text;
  v_base_revision bigint;
  v_payload jsonb;
  v_trip_id text;
  v_trip_start_text text;
  v_trip_end_text text;
  v_item_local_text text;
  v_item_arrival_text text;
  v_trip_start_date date;
  v_trip_end_date date;
  v_item_local_date date;
  v_item_arrival_date date;
  v_child record;
  v_schema_version smallint;
  v_client_created_at timestamptz;
  v_authoritative_payload jsonb;
  v_authoritative_schema_version smallint;
  v_authoritative_revision bigint;
  v_authoritative_change_sequence bigint;
  v_authoritative_updated_at timestamptz;
  v_authoritative_deleted_at timestamptz;
  v_status text;
  v_ack jsonb;
  v_inserted boolean;
  v_applied boolean;
  v_results jsonb := '[]'::jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'not authenticated';
  end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception using errcode = '42501', message = 'anonymous accounts cannot use personal cloud backup';
  end if;
  if not exists (
    select 1 from auth.users
    where id = v_user_id and coalesce(is_anonymous, false) = false
  ) then
    raise exception using errcode = '42501', message = 'personal cloud identity is unavailable';
  end if;
  if p_mutations is null or jsonb_typeof(p_mutations) <> 'array' then
    raise exception using errcode = '22023', message = 'mutations must be an array';
  end if;
  if jsonb_array_length(p_mutations) > 500 then
    raise exception using errcode = '22023', message = 'mutation batch exceeds 500 items';
  end if;
  if octet_length(p_mutations::text) > 5242880 then
    raise exception using errcode = '22023', message = 'mutation batch exceeds 5 MB';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  -- Migration 006 replaces this helper with the deletion/tombstone-aware
  -- definition. Check it before even replaying a durable acknowledgement so a
  -- stale JWT cannot recover an authoritative payload after deletion starts.
  if not public.current_personal_cloud_identity_is_active() then
    raise exception using errcode = '42501', message = 'personal cloud identity is unavailable';
  end if;

  for v_item in select value from jsonb_array_elements(p_mutations)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception using errcode = '22023', message = 'each mutation must be an object';
    end if;

    v_mutation_id := coalesce(nullif(v_item ->> 'mutationId', ''), nullif(v_item ->> 'mutation_id', ''));
    v_owner_id := coalesce(nullif(v_item ->> 'ownerId', ''), nullif(v_item ->> 'owner_id', ''));
    v_entity := v_item ->> 'entity';
    v_entity_id := coalesce(nullif(v_item ->> 'entityId', ''), nullif(v_item ->> 'entity_id', ''));
    v_operation := v_item ->> 'operation';
    v_base_revision := nullif(
      coalesce(
        v_item ->> 'baseRevision',
        v_item ->> 'base_revision',
        v_item ->> 'expectedRevision',
        v_item ->> 'expected_revision'
      ),
      ''
    )::bigint;
    v_write_policy := case
      when v_base_revision is null then 'insert-if-absent'
      else 'compare-and-set'
    end;
    v_payload := v_item -> 'payload';
    v_schema_version := coalesce(
      nullif(coalesce(v_item ->> 'schemaVersion', v_item ->> 'schema_version'), '')::smallint,
      1
    );
    v_client_created_at := nullif(
      coalesce(v_item ->> 'createdAt', v_item ->> 'created_at'),
      ''
    )::timestamptz;

    if v_mutation_id is null or char_length(v_mutation_id) > 200 then
      raise exception using errcode = '22023', message = 'invalid mutation id';
    end if;
    if v_owner_id is not null and v_owner_id <> v_user_id::text then
      raise exception using errcode = '42501', message = 'mutation owner does not match session';
    end if;
    if v_entity is null or v_entity not in (
      'calendar-entry', 'special-date', 'preference', 'stamp', 'trip', 'trip-item'
    ) then
      raise exception using errcode = '22023', message = 'unsupported mutation entity';
    end if;
    if v_entity_id is null or char_length(v_entity_id) > 500 then
      raise exception using errcode = '22023', message = 'invalid entity id';
    end if;
    if v_entity = 'preference' and v_entity_id <> 'preferences' then
      raise exception using errcode = '22023', message = 'preference entity id must be preferences';
    end if;
    if v_operation is null or v_operation not in ('upsert', 'delete') then
      raise exception using errcode = '22023', message = 'invalid mutation operation';
    end if;
    if v_base_revision is not null and v_base_revision < 0 then
      raise exception using errcode = '22023', message = 'base revision cannot be negative';
    end if;
    if v_schema_version <> 1 then
      raise exception using errcode = '22023', message = 'unsupported schema version';
    end if;
    if v_operation = 'upsert' and (
      v_payload is null
      or jsonb_typeof(v_payload) <> 'object'
      or octet_length(v_payload::text) > 1048576
    ) then
      raise exception using errcode = '22023', message = 'invalid mutation payload';
    end if;

    -- A committed mutation may be retried after its response was lost. Return
    -- the durable receipt before consulting travel state that can legitimately
    -- have changed since that first commit (for example, a deleted parent).
    v_ack := null;
    select sm.ack into v_ack
    from public.sync_mutations as sm
    where sm.user_id = v_user_id and sm.mutation_id = v_mutation_id
    for share;
    if found then
      if v_ack is null then
        raise exception using errcode = '55000', message = 'stored mutation acknowledgement is incomplete';
      end if;
      v_results := v_results || jsonb_build_array(v_ack);
      continue;
    end if;

    v_trip_id := null;
    if v_entity = 'trip-item' and v_operation = 'upsert' then
      v_trip_id := nullif(v_payload ->> 'tripId', '');
      if v_trip_id is null or char_length(v_trip_id) > 500 then
        raise exception using errcode = '22023', message = 'invalid trip item parent';
      end if;

      select parent.payload ->> 'startDate', parent.payload ->> 'endDate'
        into v_trip_start_text, v_trip_end_text
      from public.personal_trips as parent
      where parent.user_id = v_user_id
        and parent.entity_id = v_trip_id
        and parent.deleted_at is null
      for update;
      if not found then
        raise exception using errcode = '23503', message = 'trip item has no active parent';
      end if;

      v_item_local_text := nullif(v_payload ->> 'localDate', '');
      v_item_arrival_text := nullif(v_payload ->> 'arrivalLocalDate', '');
      if v_trip_start_text is null
        or v_trip_end_text is null
        or v_trip_start_text !~ '^\d{4}-\d{2}-\d{2}$'
        or v_trip_end_text !~ '^\d{4}-\d{2}-\d{2}$'
        or v_item_local_text is null
        or v_item_local_text !~ '^\d{4}-\d{2}-\d{2}$'
        or (v_item_arrival_text is not null and v_item_arrival_text !~ '^\d{4}-\d{2}-\d{2}$')
      then
        raise exception using errcode = '22023', message = 'invalid trip item or parent date';
      end if;
      begin
        v_trip_start_date := v_trip_start_text::date;
        v_trip_end_date := v_trip_end_text::date;
        v_item_local_date := v_item_local_text::date;
        v_item_arrival_date := case
          when v_item_arrival_text is null then null
          else v_item_arrival_text::date
        end;
      exception when others then
        raise exception using errcode = '22023', message = 'invalid trip item or parent date';
      end;
      if v_trip_end_date < v_trip_start_date
        or v_item_local_date < v_trip_start_date
        or v_item_local_date > v_trip_end_date
        or (v_item_arrival_date is not null and (
          v_item_arrival_date < v_trip_start_date
          or v_item_arrival_date > v_trip_end_date
        ))
      then
        raise exception using errcode = '22023', message = 'trip item date is outside the active trip period';
      end if;
    end if;
    if v_entity = 'trip' and v_operation = 'upsert' then
      v_trip_start_text := nullif(v_payload ->> 'startDate', '');
      v_trip_end_text := nullif(v_payload ->> 'endDate', '');
      if v_trip_start_text is null
        or v_trip_end_text is null
        or v_trip_start_text !~ '^\d{4}-\d{2}-\d{2}$'
        or v_trip_end_text !~ '^\d{4}-\d{2}-\d{2}$'
      then
        raise exception using errcode = '22023', message = 'invalid trip period';
      end if;
      begin
        v_trip_start_date := v_trip_start_text::date;
        v_trip_end_date := v_trip_end_text::date;
      exception when others then
        raise exception using errcode = '22023', message = 'invalid trip period';
      end;
      if v_trip_end_date < v_trip_start_date then
        raise exception using errcode = '22023', message = 'invalid trip period';
      end if;

      for v_child in
        select child.payload
        from public.personal_trip_items as child
        where child.user_id = v_user_id
          and child.trip_id = v_entity_id
          and child.deleted_at is null
        for update
      loop
        v_item_local_text := nullif(v_child.payload ->> 'localDate', '');
        v_item_arrival_text := nullif(v_child.payload ->> 'arrivalLocalDate', '');
        if v_item_local_text is null
          or v_item_local_text !~ '^\d{4}-\d{2}-\d{2}$'
          or (v_item_arrival_text is not null and v_item_arrival_text !~ '^\d{4}-\d{2}-\d{2}$')
        then
          raise exception using errcode = '22023', message = 'invalid active trip item date';
        end if;
        begin
          v_item_local_date := v_item_local_text::date;
          v_item_arrival_date := case
            when v_item_arrival_text is null then null
            else v_item_arrival_text::date
          end;
        exception when others then
          raise exception using errcode = '22023', message = 'invalid active trip item date';
        end;
        if v_item_local_date < v_trip_start_date
          or v_item_local_date > v_trip_end_date
          or (v_item_arrival_date is not null and (
            v_item_arrival_date < v_trip_start_date
            or v_item_arrival_date > v_trip_end_date
          ))
        then
          raise exception using errcode = '22023',
            message = 'active trip item date is outside the updated trip period';
        end if;
      end loop;
    end if;
    if v_operation = 'delete' then
      v_payload := null;
    end if;

    v_inserted := false;
    insert into public.sync_mutations (
      user_id,
      mutation_id,
      entity,
      entity_id,
      operation,
      write_policy,
      base_revision,
      payload,
      client_created_at,
      schema_version
    )
    values (
      v_user_id,
      v_mutation_id,
      v_entity,
      v_entity_id,
      v_operation,
      v_write_policy,
      v_base_revision,
      v_payload,
      v_client_created_at,
      v_schema_version
    )
    on conflict (user_id, mutation_id) do nothing
    returning true into v_inserted;

    if not coalesce(v_inserted, false) then
      select sm.ack into v_ack
      from public.sync_mutations as sm
      where sm.user_id = v_user_id and sm.mutation_id = v_mutation_id;
      if v_ack is null then
        raise exception using errcode = '55000', message = 'stored mutation acknowledgement is incomplete';
      end if;
      v_results := v_results || jsonb_build_array(v_ack);
      continue;
    end if;

    v_authoritative_payload := null;
    v_authoritative_schema_version := null;
    v_authoritative_revision := null;
    v_authoritative_change_sequence := null;
    v_authoritative_updated_at := null;
    v_authoritative_deleted_at := null;
    v_applied := false;

    if v_entity = 'calendar-entry' then
      if v_write_policy = 'insert-if-absent' then
        insert into public.personal_calendar_entries (
          user_id, entity_id, payload, schema_version, deleted_at
        ) values (
          v_user_id, v_entity_id, v_payload, v_schema_version,
          case when v_operation = 'delete' then now() else null end
        )
        on conflict (user_id, entity_id) do nothing
        returning payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at;
      else
        update public.personal_calendar_entries as target
        set payload = v_payload,
            schema_version = v_schema_version,
            deleted_at = case when v_operation = 'delete' then now() else null end
        where target.user_id = v_user_id
          and target.entity_id = v_entity_id
          and target.revision = v_base_revision
          and not (v_operation = 'upsert' and target.deleted_at is not null)
        returning payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at;
      end if;
      v_applied := found;
      if not v_applied then
        select payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at
        from public.personal_calendar_entries
        where user_id = v_user_id and entity_id = v_entity_id
        for share;
      end if;
    elsif v_entity = 'special-date' then
      if v_write_policy = 'insert-if-absent' then
        insert into public.personal_special_dates (
          user_id, entity_id, payload, schema_version, deleted_at
        ) values (
          v_user_id, v_entity_id, v_payload, v_schema_version,
          case when v_operation = 'delete' then now() else null end
        )
        on conflict (user_id, entity_id) do nothing
        returning payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at;
      else
        update public.personal_special_dates as target
        set payload = v_payload,
            schema_version = v_schema_version,
            deleted_at = case when v_operation = 'delete' then now() else null end
        where target.user_id = v_user_id
          and target.entity_id = v_entity_id
          and target.revision = v_base_revision
          and not (v_operation = 'upsert' and target.deleted_at is not null)
        returning payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at;
      end if;
      v_applied := found;
      if not v_applied then
        select payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at
        from public.personal_special_dates
        where user_id = v_user_id and entity_id = v_entity_id
        for share;
      end if;
    elsif v_entity = 'preference' then
      if v_write_policy = 'insert-if-absent' then
        insert into public.personal_preferences (
          user_id, payload, schema_version, deleted_at
        ) values (
          v_user_id, v_payload, v_schema_version,
          case when v_operation = 'delete' then now() else null end
        )
        on conflict (user_id) do nothing
        returning payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at;
      else
        update public.personal_preferences as target
        set payload = v_payload,
            schema_version = v_schema_version,
            deleted_at = case when v_operation = 'delete' then now() else null end
        where target.user_id = v_user_id
          and target.revision = v_base_revision
          and not (v_operation = 'upsert' and target.deleted_at is not null)
        returning payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at;
      end if;
      v_applied := found;
      if not v_applied then
        select payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at
        from public.personal_preferences
        where user_id = v_user_id
        for share;
      end if;
    elsif v_entity = 'stamp' then
      if v_write_policy = 'insert-if-absent' then
        insert into public.personal_stamps (
          user_id, entity_id, payload, schema_version, deleted_at
        ) values (
          v_user_id, v_entity_id, v_payload, v_schema_version,
          case when v_operation = 'delete' then now() else null end
        )
        on conflict (user_id, entity_id) do nothing
        returning payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at;
      else
        update public.personal_stamps as target
        set payload = v_payload,
            schema_version = v_schema_version,
            deleted_at = case when v_operation = 'delete' then now() else null end
        where target.user_id = v_user_id
          and target.entity_id = v_entity_id
          and target.revision = v_base_revision
          and not (v_operation = 'upsert' and target.deleted_at is not null)
        returning payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at;
      end if;
      v_applied := found;
      if not v_applied then
        select payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at
        from public.personal_stamps
        where user_id = v_user_id and entity_id = v_entity_id
        for share;
      end if;
    elsif v_entity = 'trip' then
      if v_write_policy = 'insert-if-absent' then
        insert into public.personal_trips (
          user_id, entity_id, payload, schema_version, deleted_at
        ) values (
          v_user_id, v_entity_id, v_payload, v_schema_version,
          case when v_operation = 'delete' then now() else null end
        )
        on conflict (user_id, entity_id) do nothing
        returning payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at;
      else
        update public.personal_trips as target
        set payload = v_payload,
            schema_version = v_schema_version,
            deleted_at = case when v_operation = 'delete' then now() else null end
        where target.user_id = v_user_id
          and target.entity_id = v_entity_id
          and target.revision = v_base_revision
          and not (v_operation = 'upsert' and target.deleted_at is not null)
        returning payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at;
      end if;
      v_applied := found;
      if v_applied and v_operation = 'delete' then
        update public.personal_trip_items as child
        set payload = null,
            deleted_at = now()
        where child.user_id = v_user_id
          and child.trip_id = v_entity_id
          and child.deleted_at is null;
      end if;
      if not v_applied then
        select payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at
        from public.personal_trips
        where user_id = v_user_id and entity_id = v_entity_id
        for share;
      end if;
    elsif v_entity = 'trip-item' then
      if v_write_policy = 'insert-if-absent' then
        insert into public.personal_trip_items (
          user_id, entity_id, trip_id, payload, schema_version, deleted_at
        ) values (
          v_user_id, v_entity_id, v_trip_id, v_payload, v_schema_version,
          case when v_operation = 'delete' then now() else null end
        )
        on conflict (user_id, entity_id) do nothing
        returning payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at;
      else
        update public.personal_trip_items as target
        set trip_id = case
              when v_operation = 'upsert' then v_trip_id
              else target.trip_id
            end,
            payload = v_payload,
            schema_version = v_schema_version,
            deleted_at = case when v_operation = 'delete' then now() else null end
        where target.user_id = v_user_id
          and target.entity_id = v_entity_id
          and target.revision = v_base_revision
          and not (v_operation = 'upsert' and target.deleted_at is not null)
        returning payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at;
      end if;
      v_applied := found;
      if not v_applied then
        select payload, schema_version, revision, change_sequence, updated_at, deleted_at
          into v_authoritative_payload, v_authoritative_schema_version,
               v_authoritative_revision, v_authoritative_change_sequence,
               v_authoritative_updated_at, v_authoritative_deleted_at
        from public.personal_trip_items
        where user_id = v_user_id and entity_id = v_entity_id
        for share;
      end if;
    end if;

    v_status := case when v_applied then 'applied' else 'conflict' end;
    if not v_applied then
      v_status := 'conflict';
    end if;
    v_ack := jsonb_build_object(
      'mutationId', v_mutation_id,
      'ownerId', v_user_id,
      'entity', v_entity,
      'entityId', v_entity_id,
      'status', v_status,
      'revision', v_authoritative_revision,
      'changeSequence', v_authoritative_change_sequence,
      'deleted', v_authoritative_deleted_at is not null,
      'deletedAt', v_authoritative_deleted_at,
      'payload', v_authoritative_payload,
      'schemaVersion', v_authoritative_schema_version,
      'updatedAt', v_authoritative_updated_at,
      'authoritative', case when v_authoritative_revision is null then null else jsonb_build_object(
        'ownerId', v_user_id,
        'entity', v_entity,
        'id', v_entity_id,
        'revision', v_authoritative_revision,
        'changeSequence', v_authoritative_change_sequence,
        'payload', v_authoritative_payload,
        'updatedAt', v_authoritative_updated_at,
        'deletedAt', v_authoritative_deleted_at,
        'schemaVersion', v_authoritative_schema_version
      ) end,
      'row', case when v_authoritative_revision is null then null else jsonb_build_object(
        'ownerId', v_user_id,
        'entity', v_entity,
        'id', v_entity_id,
        'revision', v_authoritative_revision,
        'changeSequence', v_authoritative_change_sequence,
        'payload', v_authoritative_payload,
        'updatedAt', v_authoritative_updated_at,
        'deletedAt', v_authoritative_deleted_at,
        'schemaVersion', v_authoritative_schema_version
      ) end
    );

    update public.sync_mutations
    set ack = v_ack,
        status = v_status
    where user_id = v_user_id and mutation_id = v_mutation_id;

    v_results := v_results || jsonb_build_array(v_ack);
  end loop;

  return v_results;
end;
$$;

revoke all on function public.apply_personal_mutations(jsonb) from public;
revoke all on function public.apply_personal_mutations(jsonb) from anon;
revoke all on function public.apply_personal_mutations(jsonb) from authenticated;
grant execute on function public.apply_personal_mutations(jsonb) to authenticated, service_role;

-- Storage objects are never public. The first object-name segment is the auth
-- UID, so even a guessed object key cannot cross account boundaries.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('personal-media', 'personal-media', false, 5242880, array['image/jpeg'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists personal_media_read on storage.objects;
create policy personal_media_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'personal-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists personal_media_insert on storage.objects;
create policy personal_media_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'personal-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists personal_media_update on storage.objects;
create policy personal_media_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'personal-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'personal-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists personal_media_delete on storage.objects;
create policy personal_media_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'personal-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

commit;
