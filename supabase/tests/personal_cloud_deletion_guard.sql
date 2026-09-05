-- Run after migrations 000-009 with `supabase test db`.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(3);

insert into auth.users (id, aud, role, email, is_anonymous, created_at, updated_at)
values (
  '90000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'stale-jwt@example.invalid', false,
  now(), now()
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false}',
  true
);

select extensions.lives_ok(
  $$select public.apply_personal_mutations('[{
    "mutationId":"stale-receipt-1",
    "ownerId":"90000000-0000-4000-8000-000000000001",
    "entity":"preference",
    "entityId":"preferences",
    "operation":"upsert",
    "baseRevision":null,
    "schemaVersion":1,
    "payload":{"weekStartDay":0},
    "createdAt":"2026-09-05T00:00:00.000Z"
  }]'::jsonb)$$,
  'an active account can create a durable mutation receipt'
);

reset role;
insert into public.deleted_account_tombstones (
  user_id, reason, replacement_user_id, deleted_at, delete_after
)
select
  '90000000-0000-4000-8000-000000000001',
  'deleted', null, frozen_at, frozen_at + interval '90 days'
from (select clock_timestamp() as frozen_at) frozen;

set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false}',
  true
);

select extensions.throws_ok(
  $$select public.apply_personal_mutations('[{
    "mutationId":"stale-receipt-1",
    "ownerId":"90000000-0000-4000-8000-000000000001",
    "entity":"preference",
    "entityId":"preferences",
    "operation":"upsert",
    "baseRevision":null,
    "schemaVersion":1,
    "payload":{"weekStartDay":0},
    "createdAt":"2026-09-05T00:00:00.000Z"
  }]'::jsonb)$$,
  '42501', 'personal cloud identity is unavailable',
  'a stale JWT cannot replay an acknowledgement containing authoritative data'
);

select extensions.throws_ok(
  $$select public.apply_personal_mutations('[]'::jsonb)$$,
  '42501', 'personal cloud identity is unavailable',
  'a stale JWT cannot probe the mutation endpoint with an empty batch'
);

select * from extensions.finish();
rollback;
