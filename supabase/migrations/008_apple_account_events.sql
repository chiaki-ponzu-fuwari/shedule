-- Apple Sign in server-to-server account events. Only an Edge Function that
-- has verified Apple's JWS may call these service-role-only RPCs.

begin;

create unique index if not exists apple_credentials_provider_subject_hash_uidx
  on private.apple_credentials (provider_subject_hash);

alter table private.apple_credentials
  add column if not exists credential_issued_at timestamptz,
  add column if not exists credential_bound_at timestamptz;
-- Legacy rows predate verified generation tracking. Negative infinity makes
-- deletion notifications fail open for privacy instead of suppressing a real
-- revocation based on a later database commit timestamp.
update private.apple_credentials
set credential_issued_at = '-infinity'::timestamptz
where credential_issued_at is null;
update private.apple_credentials
set credential_bound_at = '-infinity'::timestamptz
where credential_bound_at is null;
alter table private.apple_credentials
  alter column credential_issued_at set not null,
  alter column credential_bound_at set not null;

-- A durable subject-scoped claim ensures that only one request exchanges an
-- Apple authorization code while no credential exists. It closes the race in
-- which a concurrent loser could create a second, untracked refresh token.
create table if not exists private.apple_credential_store_claims (
  provider_subject_hash text primary key
    check (provider_subject_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  claim_id uuid not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  exchange_started_at timestamptz,
  check (expires_at >= created_at + interval '10 minutes'),
  check (exchange_started_at is null or exchange_started_at >= created_at)
);

alter table private.apple_credential_store_claims enable row level security;
alter table private.apple_credential_store_claims force row level security;
revoke all on table private.apple_credential_store_claims from public;
revoke all on table private.apple_credential_store_claims from anon;
revoke all on table private.apple_credential_store_claims from authenticated;
grant select, insert, update, delete on table private.apple_credential_store_claims to service_role;

create or replace function public.begin_apple_credential_store(
  p_user_id uuid,
  p_provider_subject_hash text,
  p_claim_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential private.apple_credentials%rowtype;
  v_claim private.apple_credential_store_claims%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_claim_id is null
    or p_provider_subject_hash is null
    or p_provider_subject_hash !~ '^[0-9A-Fa-f]{64}$' then
    raise exception using errcode = '22023', message = 'valid Apple credential claim inputs are required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('apple-credential:' || lower(p_provider_subject_hash), 0)
  );
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

  select * into v_credential
  from private.apple_credentials credential
  where credential.user_id = p_user_id
  for update;
  if found then
    if v_credential.provider_subject_hash <> lower(p_provider_subject_hash) then
      raise exception using errcode = '23505', message = 'Apple credential identity does not match';
    end if;
    return 'existing';
  end if;
  if exists (
    select 1 from private.apple_credentials credential
    where credential.provider_subject_hash = lower(p_provider_subject_hash)
  ) then
    raise exception using errcode = '23505', message = 'Apple credential identity is already owned';
  end if;

  delete from private.apple_credential_store_claims claim
  where claim.exchange_started_at is null
    and claim.expires_at <= v_now
    and (
      claim.user_id = p_user_id
      or claim.provider_subject_hash = lower(p_provider_subject_hash)
    );
  select * into v_claim
  from private.apple_credential_store_claims claim
  where claim.user_id = p_user_id
     or claim.provider_subject_hash = lower(p_provider_subject_hash)
  for update;
  if found then
    if v_claim.user_id <> p_user_id
      or v_claim.provider_subject_hash <> lower(p_provider_subject_hash) then
      raise exception using errcode = '23505', message = 'Apple credential claim identity does not match';
    end if;
    if v_claim.exchange_started_at is not null then
      -- Once an external exchange could have created a grant, never let a TTL
      -- authorize another code exchange. An operator or account deletion must
      -- reconcile this intentionally.
      return 'uncertain';
    end if;
    if v_claim.claim_id = p_claim_id then
      return 'acquired';
    end if;
    return 'pending';
  end if;

  insert into private.apple_credential_store_claims (
    provider_subject_hash, user_id, claim_id, created_at, expires_at
  ) values (
    lower(p_provider_subject_hash), p_user_id, p_claim_id,
    v_now, v_now + interval '10 minutes'
  );
  return 'acquired';
end;
$$;

create or replace function public.mark_apple_credential_exchange_started(
  p_user_id uuid,
  p_provider_subject_hash text,
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_claim_id is null
    or p_provider_subject_hash is null
    or p_provider_subject_hash !~ '^[0-9A-Fa-f]{64}$' then
    raise exception using errcode = '22023', message = 'valid Apple credential claim inputs are required';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('apple-credential:' || lower(p_provider_subject_hash), 0)
  );
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  if exists (
    select 1 from public.account_deletion_requests
    where user_id = p_user_id and authorized_at is not null
  ) or exists (
    select 1 from public.deleted_account_tombstones where user_id = p_user_id
  ) then
    raise exception using errcode = '55000', message = 'credential owner is unavailable';
  end if;
  update private.apple_credential_store_claims
  set exchange_started_at = clock_timestamp()
  where user_id = p_user_id
    and provider_subject_hash = lower(p_provider_subject_hash)
    and claim_id = p_claim_id
    and exchange_started_at is null
    and expires_at > clock_timestamp();
  return found;
end;
$$;

create or replace function public.complete_apple_credential_store(
  p_user_id uuid,
  p_provider_subject_hash text,
  p_claim_id uuid,
  p_ciphertext_base64 text,
  p_encryption_key_id text,
  p_credential_issued_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim private.apple_credential_store_claims%rowtype;
  v_credential private.apple_credentials%rowtype;
  v_ciphertext bytea;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_claim_id is null
    or p_provider_subject_hash is null
    or p_provider_subject_hash !~ '^[0-9A-Fa-f]{64}$'
    or p_ciphertext_base64 is null or char_length(p_ciphertext_base64) > 32768
    or p_encryption_key_id is null
    or char_length(p_encryption_key_id) not between 1 and 200
    or p_credential_issued_at is null
    or p_credential_issued_at < v_now - interval '15 minutes'
    or p_credential_issued_at > v_now + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'valid Apple credential inputs are required';
  end if;
  begin
    v_ciphertext := decode(p_ciphertext_base64, 'base64');
  exception when others then
    raise exception using errcode = '22023', message = 'invalid encrypted credential encoding';
  end;
  if octet_length(v_ciphertext) not between 16 and 16384 then
    raise exception using errcode = '22023', message = 'invalid encrypted credential size';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('apple-credential:' || lower(p_provider_subject_hash), 0)
  );
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

  select * into v_claim
  from private.apple_credential_store_claims claim
  where claim.user_id = p_user_id
    and claim.provider_subject_hash = lower(p_provider_subject_hash)
    and claim.claim_id = p_claim_id
    and claim.exchange_started_at is not null
  for update;
  if not found then
    -- An RPC response may be lost after commit. Accept only the exact encrypted
    -- generation from this invocation; never treat another token as equivalent.
    select * into v_credential
    from private.apple_credentials credential
    where credential.user_id = p_user_id
      and credential.provider_subject_hash = lower(p_provider_subject_hash)
      and credential.encrypted_refresh_token = v_ciphertext
      and credential.encryption_key_id = p_encryption_key_id
      and credential.credential_issued_at = p_credential_issued_at;
    if found then return true; end if;
    raise exception using errcode = '55000', message = 'Apple credential claim is unavailable';
  end if;

  insert into private.apple_credentials (
    user_id, provider_subject_hash, encrypted_refresh_token,
    encryption_key_id, credential_issued_at, credential_bound_at
  ) values (
    p_user_id, lower(p_provider_subject_hash), v_ciphertext,
    p_encryption_key_id, p_credential_issued_at, v_claim.exchange_started_at
  );
  delete from private.apple_credential_store_claims
  where claim_id = p_claim_id;
  return true;
end;
$$;

create or replace function public.reconcile_apple_credential_store(
  p_user_id uuid,
  p_provider_subject_hash text,
  p_claim_id uuid,
  p_provider_revocation_confirmed boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_claim_id is null
    or p_provider_subject_hash is null
    or p_provider_subject_hash !~ '^[0-9A-Fa-f]{64}$'
    or p_provider_revocation_confirmed is distinct from true then
    raise exception using errcode = '22023', message = 'confirmed Apple provider revocation is required';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('apple-credential:' || lower(p_provider_subject_hash), 0)
  );
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  if exists (
    select 1 from private.apple_credentials credential
    where credential.user_id = p_user_id
       or credential.provider_subject_hash = lower(p_provider_subject_hash)
  ) then
    raise exception using errcode = '55000', message = 'a stored Apple credential must use normal deletion';
  end if;
  delete from private.apple_credential_store_claims
  where user_id = p_user_id
    and provider_subject_hash = lower(p_provider_subject_hash)
    and claim_id = p_claim_id
    and exchange_started_at is not null;
  return found;
end;
$$;

create table if not exists private.apple_account_events (
  event_id text primary key
    check (char_length(event_id) between 1 and 512),
  provider_subject_hash text not null
    check (provider_subject_hash ~ '^[0-9a-f]{64}$'),
  event_type text not null
    check (event_type in ('consent-revoked', 'account-deleted')),
  event_time timestamptz not null,
  -- No Auth foreign keys: this idempotency record outlives Auth deletion.
  user_id uuid,
  deletion_request_id uuid,
  status text not null
    check (status in ('unmatched', 'ignored', 'processing', 'completed')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  delete_after timestamptz not null default (now() + interval '90 days'),
  check (delete_after >= received_at + interval '90 days'),
  check ((status in ('unmatched', 'ignored')) = (user_id is null)),
  check ((user_id is null) = (deletion_request_id is null)),
  check ((status in ('unmatched', 'ignored', 'completed')) = (processed_at is not null))
);

create index if not exists apple_account_events_delete_after_idx
  on private.apple_account_events (delete_after);
create index if not exists apple_account_events_user_id_idx
  on private.apple_account_events (user_id)
  where user_id is not null;

alter table private.apple_account_events enable row level security;
alter table private.apple_account_events force row level security;
revoke all on table private.apple_account_events from public;
revoke all on table private.apple_account_events from anon;
revoke all on table private.apple_account_events from authenticated;
grant select, insert, update, delete on table private.apple_account_events to service_role;

create or replace function public.begin_apple_account_event(
  p_event_id text,
  p_provider_subject_hash text,
  p_event_type text,
  p_event_time timestamptz,
  p_request_id uuid,
  p_receipt_secret_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event private.apple_account_events%rowtype;
  v_request public.account_deletion_requests%rowtype;
  v_user_id uuid;
  v_credential_bound_at timestamptz;
  v_mapping_source text;
  v_now timestamptz := clock_timestamp();
  v_has_google boolean := false;
begin
  if p_event_id is null or char_length(p_event_id) not between 1 and 512
    or p_provider_subject_hash is null
    or p_provider_subject_hash !~ '^[0-9A-Fa-f]{64}$'
    or p_event_type not in ('consent-revoked', 'account-deleted')
    or p_event_time is null or p_event_time > v_now + interval '5 minutes'
    or p_request_id is null
    or p_receipt_secret_hash is null
    or p_receipt_secret_hash !~ '^[0-9A-Fa-f]{64}$' then
    raise exception using errcode = '22023', message = 'valid Apple account event inputs are required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('apple-event:' || lower(p_provider_subject_hash), 0)
  );
  -- Serialize subject mapping against the store claim and credential commit.
  -- A revocation delivered after Apple's exchange but before our encrypted
  -- credential commit must bind to the durable exchange-started claim instead
  -- of being acknowledged forever as unmatched.
  perform pg_advisory_xact_lock(
    hashtextextended('apple-credential:' || lower(p_provider_subject_hash), 0)
  );
  select * into v_event
  from private.apple_account_events
  where event_id = p_event_id
  for update;
  if found then
    if v_event.provider_subject_hash <> lower(p_provider_subject_hash)
      or v_event.event_type <> p_event_type
      or v_event.event_time <> p_event_time then
      raise exception using errcode = '23505', message = 'Apple event id is already in use';
    end if;
    if v_event.user_id is null then
      return jsonb_build_object('matched', false, 'status', v_event.status);
    end if;
    select * into v_request
    from public.account_deletion_requests
    where request_id = v_event.deletion_request_id
    for update;
    if not found then
      raise exception using errcode = '55000', message = 'Apple event deletion request is missing';
    end if;
    return jsonb_build_object(
      'matched', true,
      'status', v_event.status,
      'user_id', v_event.user_id,
      'request_id', v_event.deletion_request_id,
      'provider_revoked_at', v_request.provider_revoked_at,
      'storage_cleared_at', v_request.storage_cleared_at,
      'db_cleared_at', v_request.db_cleared_at,
      'manual_revocation_required', v_request.manual_revocation_required
    );
  end if;

  select credential.user_id, credential.credential_bound_at
  into v_user_id, v_credential_bound_at
  from private.apple_credentials credential
  where credential.provider_subject_hash = lower(p_provider_subject_hash);
  if found then
    v_mapping_source := 'credential';
  else
    select claim.user_id, claim.exchange_started_at
    into v_user_id, v_credential_bound_at
    from private.apple_credential_store_claims claim
    where claim.provider_subject_hash = lower(p_provider_subject_hash)
      and claim.exchange_started_at is not null;
    if found then v_mapping_source := 'claim'; end if;
  end if;
  if v_user_id is null then
    insert into private.apple_account_events (
      event_id, provider_subject_hash, event_type, event_time,
      status, processed_at, received_at, delete_after
    ) values (
      p_event_id, lower(p_provider_subject_hash), p_event_type, p_event_time,
      'unmatched', v_now, v_now, v_now + interval '90 days'
    );
    return jsonb_build_object('matched', false, 'status', 'unmatched');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  -- Recheck both sides of the private subject-to-UID mapping under the Auth row
  -- lock. A stale or cross-user subject can never select another account.
  if v_mapping_source = 'credential' then
    select credential.user_id, credential.credential_bound_at
    into v_user_id, v_credential_bound_at
    from private.apple_credentials credential
    join auth.users auth_user on auth_user.id = credential.user_id
    where credential.provider_subject_hash = lower(p_provider_subject_hash)
    for update of credential, auth_user;
  else
    select claim.user_id, claim.exchange_started_at
    into v_user_id, v_credential_bound_at
    from private.apple_credential_store_claims claim
    join auth.users auth_user on auth_user.id = claim.user_id
    where claim.provider_subject_hash = lower(p_provider_subject_hash)
      and claim.exchange_started_at is not null
    for update of claim, auth_user;
  end if;
  if v_user_id is null then
    insert into private.apple_account_events (
      event_id, provider_subject_hash, event_type, event_time,
      status, processed_at, received_at, delete_after
    ) values (
      p_event_id, lower(p_provider_subject_hash), p_event_type, p_event_time,
      'unmatched', v_now, v_now, v_now + interval '90 days'
    );
    return jsonb_build_object('matched', false, 'status', 'unmatched');
  end if;

  -- Apple ID-token iat is only second-precision, while event_time can carry
  -- milliseconds. Bind the credential to the server timestamp recorded just
  -- before token exchange so a same-second event from the prior generation
  -- cannot delete the newly linked account. The pre-exchange boundary also
  -- keeps an event arriving between exchange and commit in the new generation.
  if p_event_time < v_credential_bound_at then
    insert into private.apple_account_events (
      event_id, provider_subject_hash, event_type, event_time,
      status, processed_at, received_at, delete_after
    ) values (
      p_event_id, lower(p_provider_subject_hash), p_event_type, p_event_time,
      'ignored', v_now, v_now, v_now + interval '90 days'
    );
    return jsonb_build_object('matched', false, 'status', 'ignored');
  end if;

  select exists (
    select 1 from auth.identities
    where user_id = v_user_id and provider = 'google'
  ) into v_has_google;

  select * into v_request
  from public.account_deletion_requests
  where user_id = v_user_id
  for update;
  if found and v_request.authorized_at is null then
    -- A signed Apple deletion event supersedes an unconfirmed client challenge.
    delete from public.account_deletion_requests where id = v_request.id;
    v_request := null;
  end if;

  if v_request.id is null then
    if exists (
      select 1 from public.deleted_account_tombstones
      where user_id = v_user_id and reason <> 'deleted'
    ) then
      raise exception using errcode = '55000', message = 'Apple event account is unavailable';
    end if;
    insert into public.deleted_account_tombstones (
      user_id, reason, replacement_user_id, deleted_at, delete_after
    ) values (
      v_user_id, 'deleted', null, v_now, v_now + interval '90 days'
    ) on conflict (user_id) do nothing;

    insert into public.account_deletion_requests (
      user_id, request_id, receipt_hash, status, authorized_at, provider_revoked_at,
      google_revocation_handled_at, manual_revocation_required,
      challenge_created_at, expires_at, updated_at, delete_after, attempts
    ) values (
      v_user_id, p_request_id, lower(p_receipt_secret_hash), 'processing', v_now, v_now,
      case when v_has_google then v_now else null end, v_has_google,
      v_now, v_now + interval '10 minutes', v_now, v_now + interval '90 days', 1
    ) returning * into v_request;
  else
    if not exists (
      select 1 from public.deleted_account_tombstones
      where user_id = v_user_id and reason = 'deleted'
    ) then
      raise exception using errcode = '55000', message = 'Authorized deletion tombstone is missing';
    end if;
    update public.account_deletion_requests
    set provider_revoked_at = coalesce(provider_revoked_at, v_now),
        google_revocation_handled_at = case
          when v_has_google then coalesce(google_revocation_handled_at, v_now)
          else google_revocation_handled_at
        end,
        manual_revocation_required = manual_revocation_required or v_has_google,
        status = case when db_cleared_at is null then 'processing' else status end,
        error_code = null,
        updated_at = v_now
    where id = v_request.id
    returning * into v_request;
  end if;

  insert into private.apple_account_events (
    event_id, provider_subject_hash, event_type, event_time,
    user_id, deletion_request_id, status, received_at, delete_after
  ) values (
    p_event_id, lower(p_provider_subject_hash), p_event_type, p_event_time,
    v_user_id, v_request.request_id, 'processing', v_now, v_now + interval '90 days'
  ) returning * into v_event;

  return jsonb_build_object(
    'matched', true,
    'status', v_event.status,
    'user_id', v_user_id,
    'request_id', v_request.request_id,
    'provider_revoked_at', v_request.provider_revoked_at,
    'storage_cleared_at', v_request.storage_cleared_at,
    'db_cleared_at', v_request.db_cleared_at,
    'manual_revocation_required', v_request.manual_revocation_required
  );
end;
$$;

create or replace function public.complete_apple_account_event(
  p_event_id text,
  p_user_id uuid,
  p_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event private.apple_account_events%rowtype;
  v_request public.account_deletion_requests%rowtype;
  v_completed_at timestamptz;
begin
  if p_event_id is null or p_user_id is null or p_request_id is null then
    raise exception using errcode = '22023', message = 'valid Apple event completion inputs are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into v_event
  from private.apple_account_events
  where event_id = p_event_id
  for update;
  if not found or v_event.user_id is distinct from p_user_id
    or v_event.deletion_request_id is distinct from p_request_id then
    raise exception using errcode = '42501', message = 'Apple event does not match deletion';
  end if;
  if v_event.status = 'completed' then
    return true;
  end if;

  select * into v_request
  from public.account_deletion_requests
  where request_id = p_request_id
  for update;
  if not found or v_request.user_id is distinct from p_user_id
    or v_request.db_cleared_at is null then
    raise exception using errcode = '55000', message = 'Apple event deletion is incomplete';
  end if;
  if exists (
    select 1 from auth.users where id = p_user_id
  ) then
    raise exception using errcode = '55000', message = 'Apple event Auth deletion is incomplete';
  end if;

  v_completed_at := clock_timestamp();
  update public.account_deletion_requests
  set status = 'completed',
      completed_at = v_completed_at,
      user_id = null,
      error_code = null,
      updated_at = v_completed_at,
      delete_after = v_completed_at + interval '90 days'
  where id = v_request.id;
  update private.apple_account_events
  set status = 'completed',
      processed_at = clock_timestamp(),
      delete_after = clock_timestamp() + interval '90 days'
  where event_id = p_event_id;
  return true;
end;
$$;

create or replace function public.purge_expired_apple_account_events()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  with doomed as (
    select event_id
    from private.apple_account_events
    where delete_after <= clock_timestamp()
      and status in ('unmatched', 'ignored', 'completed')
    order by delete_after, event_id
    limit 500
    for update skip locked
  )
  delete from private.apple_account_events target
  using doomed
  where target.event_id = doomed.event_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.begin_apple_account_event(text, text, text, timestamptz, uuid, text) from public;
revoke all on function public.begin_apple_account_event(text, text, text, timestamptz, uuid, text) from anon;
revoke all on function public.begin_apple_account_event(text, text, text, timestamptz, uuid, text) from authenticated;
grant execute on function public.begin_apple_account_event(text, text, text, timestamptz, uuid, text) to service_role;

revoke all on function public.begin_apple_credential_store(uuid, text, uuid) from public;
revoke all on function public.begin_apple_credential_store(uuid, text, uuid) from anon;
revoke all on function public.begin_apple_credential_store(uuid, text, uuid) from authenticated;
grant execute on function public.begin_apple_credential_store(uuid, text, uuid) to service_role;

revoke all on function public.mark_apple_credential_exchange_started(uuid, text, uuid) from public;
revoke all on function public.mark_apple_credential_exchange_started(uuid, text, uuid) from anon;
revoke all on function public.mark_apple_credential_exchange_started(uuid, text, uuid) from authenticated;
grant execute on function public.mark_apple_credential_exchange_started(uuid, text, uuid) to service_role;

revoke all on function public.complete_apple_credential_store(uuid, text, uuid, text, text, timestamptz) from public;
revoke all on function public.complete_apple_credential_store(uuid, text, uuid, text, text, timestamptz) from anon;
revoke all on function public.complete_apple_credential_store(uuid, text, uuid, text, text, timestamptz) from authenticated;
grant execute on function public.complete_apple_credential_store(uuid, text, uuid, text, text, timestamptz) to service_role;

revoke all on function public.reconcile_apple_credential_store(uuid, text, uuid, boolean) from public;
revoke all on function public.reconcile_apple_credential_store(uuid, text, uuid, boolean) from anon;
revoke all on function public.reconcile_apple_credential_store(uuid, text, uuid, boolean) from authenticated;
grant execute on function public.reconcile_apple_credential_store(uuid, text, uuid, boolean) to service_role;
revoke all on function public.store_apple_credential(uuid, text, text, text) from service_role;

revoke all on function public.complete_apple_account_event(text, uuid, uuid) from public;
revoke all on function public.complete_apple_account_event(text, uuid, uuid) from anon;
revoke all on function public.complete_apple_account_event(text, uuid, uuid) from authenticated;
grant execute on function public.complete_apple_account_event(text, uuid, uuid) to service_role;

revoke all on function public.purge_expired_apple_account_events() from public;
revoke all on function public.purge_expired_apple_account_events() from anon;
revoke all on function public.purge_expired_apple_account_events() from authenticated;
grant execute on function public.purge_expired_apple_account_events() to service_role;

commit;
