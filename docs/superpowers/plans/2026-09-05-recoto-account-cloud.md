# Recoto Account, Cloud Restore, and Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let guests connect Google or Apple, restore personal data after reinstall, remain safe offline, and delete the account plus associated cloud data from inside the app.

**Architecture:** Supabase is the source of truth only after account connection; local data remains an owner-scoped cache with a durable mutation outbox. Authentication for backup is separate from Google Calendar OAuth. New identities link to the anonymous UID; an already-owned identity uses a short-lived two-session merge intent. Deletion is an authenticated, idempotent server workflow.

**Tech Stack:** Supabase Auth/Postgres/Storage/Edge Functions, Expo AuthSession, Expo AppleAuthentication, Expo SecureStore, AsyncStorage, Zustand, Jest.

---

## File map

- Create `types/account.ts`: account, sync, outbox, snapshot, and error contracts.
- Create `tests/account/fixtures.ts`: typed in-memory repository/auth/lifecycle doubles shared by account tests.
- Create `lib/account/personalSnapshot.ts`: portable data sanitizer and mapper.
- Create `lib/account/namespacedStorage.ts`: `guest:<installationId>` and `user:<uid>` cache isolation.
- Create `lib/account/cloudRepository.ts`: repository interface and Supabase implementation.
- Create `lib/account/syncEngine.ts`: remote-first migration, outbox replay, conflict backup, tombstones.
- Create `lib/account/personalMedia.ts`: re-encoded private image upload, signed reads, retry, and orphan cleanup.
- Create `store/accountStore.ts`: UI-safe account/sync state machine.
- Create `hooks/useAccountBootstrap.ts`, `hooks/useAccountAuth.ts`: restore and provider flows.
- Create `components/settings/AccountBackupCard.tsx`, `components/settings/DeleteAccountSheet.tsx`.
- Create `app/auth/callback.tsx`: PKCE callback exchange.
- Create `supabase/migrations/000_group_base_schema.sql`: reproducible existing group base tables.
- Create `supabase/migrations/005_personal_cloud.sql`: personal tables, indexes, RLS, storage policies.
- Create `supabase/migrations/006_account_lifecycle.sql`: merge/deletion state and restricted RPCs.
- Create Edge Functions `start-account-merge`, `complete-account-merge`, `store-apple-token`, and `delete-account` plus shared helpers.
- Modify `calendarStore`, `stampStore`, `localeStore`: owner-scoped persistence and explicit reset/replace actions.
- Modify `app/_layout.tsx`, `app/(tabs)/settings.tsx`, `app.json`, `.env.example`, `DEPLOY_CHECKLIST.md`, `package*.json`.

### Task 1: Define and test the portable personal snapshot

- [ ] **Step 1: Write the failing sanitizer test**

Create `tests/account/personalSnapshot.test.ts`:

```ts
import { createPortableCalendarEntry } from '../../lib/account/personalSnapshot';

test('removes device-only values from cloud calendar payloads', () => {
  const payload = createPortableCalendarEntry({
    date: '2026-09-05',
    miniStamps: {},
    privacyLevel: 2,
    notificationId: 'local-notification',
    imageUri: 'file:///private/photo.jpg',
    noteItems: [{
      id: 'n1', text: 'Flight', notificationId: 'n2', googlePushFingerprint: 'secret-ish',
    }],
  });
  expect(payload.notificationId).toBeUndefined();
  expect(payload.imageUri).toBeUndefined();
  expect(payload.noteItems?.[0].notificationId).toBeUndefined();
  expect(payload.noteItems?.[0].googlePushFingerprint).toBeUndefined();
  expect(payload.noteItems?.[0].text).toBe('Flight');
});
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/account/personalSnapshot.test.ts`.
Expected: FAIL because the mapper does not exist.

- [ ] **Step 3: Implement account contracts and sanitizer**

In `types/account.ts`, define:

```ts
export type AccountMode = 'guest-local' | 'guest-connected' | 'account-connected' | 'deletion-pending';
export type SyncPhase = 'local-only' | 'pending' | 'syncing' | 'synced' | 'reauth-required' | 'conflict-backed-up' | 'error';
export type CloudEntity = 'calendar-entry' | 'special-date' | 'preference' | 'stamp' | 'trip' | 'trip-item';
export interface OutboxMutation {
  mutationId: string;
  ownerId: string;
  entity: CloudEntity;
  entityId: string;
  operation: 'upsert' | 'delete';
  payload: Record<string, unknown> | null;
  createdAt: string;
  attempts: number;
}
```

Implement deep copies in `personalSnapshot.ts`; strip `notificationId`, `googlePushFingerprint`, access/refresh tokens, `file://`/`content://` URIs, and temporary UI fields without mutating the Zustand object.

Create `tests/account/fixtures.ts` with concrete defaults rather than ad-hoc mocks:

```ts
export const emptyPersonalSnapshot = () => ({ entries: {}, specialDates: [], preferences: {}, stamps: [], trips: [], tripItems: [] });
export const fullPersonalSnapshot = () => ({
  entries: { '2026-09-05': { date: '2026-09-05', miniStamps: {}, privacyLevel: 2, notes: 'saved' } },
  specialDates: [], preferences: { weekStartDay: 1 }, stamps: [], trips: [], tripItems: [],
});
export const mutationFixture = (overrides = {}) => ({
  mutationId: 'm-default', ownerId: 'u1', entity: 'calendar-entry', entityId: 'd1',
  operation: 'upsert', payload: { notes: 'saved' }, createdAt: '2026-09-05T00:00:00Z', attempts: 0,
  ...overrides,
});
```

The same file exports stateful `fakeAuthGateway` and `lifecycleFixture` doubles that record ordered calls and implement the exact `AuthGateway`/`AccountLifecycleDependencies` interfaces defined in production; their defaults use user `guest-1`/`user-1`, the snapshots above, and `jest.fn` notification/credential cleanup functions.

- [ ] **Step 4: Verify GREEN and commit**

Run `npm test -- tests/account/personalSnapshot.test.ts && npm run typecheck`.
Then:

```bash
git add types/account.ts lib/account/personalSnapshot.ts tests/account/personalSnapshot.test.ts
git commit -m "feat: define portable personal backup payloads"
```

### Task 2: Isolate local caches by owner

- [ ] **Step 1: Write failing namespace and migration tests**

Create `tests/account/namespacedStorage.test.ts` with an in-memory AsyncStorage double and assert:

```ts
expect(ownerStorage.key('calendar')).toBe('recoto:guest:install-1:calendar');
await ownerStorage.switchOwner({ kind: 'user', id: 'user-b' });
expect(ownerStorage.key('calendar')).toBe('recoto:user:user-b:calendar');
expect(await ownerStorage.migrateLegacy('calendar-storage', 'calendar')).toEqual({ migrated: true });
expect(await ownerStorage.migrateLegacy('calendar-storage', 'calendar')).toEqual({ migrated: false });
```

Also assert that switching from user A to user B clears in-memory Calendar/Stamp state before rehydration and never exposes A's values.

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/account/namespacedStorage.test.ts`.
Expected: FAIL because the storage service is absent.

- [ ] **Step 3: Implement owner-scoped storage**

Create a persisted installation ID with `expo-crypto.randomUUID()`. Expose:

```ts
export type DataOwner = { kind: 'guest'; id: string } | { kind: 'user'; id: string };
export function createOwnerStorage(storage: AsyncStorageStatic): {
  getOwner(): Promise<DataOwner>;
  switchOwner(owner: DataOwner): Promise<void>;
  key(domain: string): string;
  migrateLegacy(oldKey: string, domain: string): Promise<{ migrated: boolean }>;
};
```

Add `replaceState` and `clearForOwnerSwitch` actions to Calendar and Stamp stores. Migrate each old key once into a read-only `recoto:migration-backup:<timestamp>:<key>` copy before writing the guest namespace.

- [ ] **Step 4: Verify GREEN and commit**

Run `npm test -- tests/account/namespacedStorage.test.ts && npm run typecheck`.
Then commit only owner-storage, store, and test files as `feat: isolate personal caches by account`.

### Task 3: Build the remote-first sync engine and outbox

- [ ] **Step 1: Write failing repository-level tests**

Create `tests/account/syncEngine.test.ts` using a real in-memory repository implementing the production interface. Cover these exact cases:

```ts
import { createMemoryCloudRepository, runInitialMigration, flushOutbox } from '../../lib/account/syncEngine';
import { mutationFixture } from './fixtures';

test('downloads remote state before uploading missing local rows', async () => {
  const repository = createMemoryCloudRepository([{ id: 'same', revision: 2, payload: { notes: 'remote' } }]);
  const result = await runInitialMigration({
    ownerId: 'u1',
    localRows: [
      { id: 'same', revision: 1, payload: { notes: 'local' } },
      { id: 'local-only', revision: 1, payload: { notes: 'new' } },
    ],
    repository,
  });
  expect(result.rows.find((row) => row.id === 'same')?.payload).toEqual({ notes: 'remote' });
  expect(repository.rows.has('local-only')).toBe(true);
  expect(result.conflictBackups).toEqual([expect.objectContaining({ id: 'same' })]);
});

test('replaying one mutation twice writes one remote revision', async () => {
  const repository = createMemoryCloudRepository([]);
  const mutation = mutationFixture({ mutationId: 'm1', entityId: 'd1' });
  await flushOutbox([mutation, mutation], repository);
  expect(repository.appliedMutationIds).toEqual(['m1']);
  expect(repository.rows.get('d1')?.revision).toBe(1);
});

test('a tombstone is not resurrected by a stale device', async () => {
  const repository = createMemoryCloudRepository([
    { id: 'd1', revision: 5, payload: null, deletedAt: '2026-09-01T00:00:00Z' },
  ]);
  const result = await runInitialMigration({
    ownerId: 'u1',
    localRows: [{ id: 'd1', revision: 2, payload: { notes: 'stale' } }],
    repository,
  });
  expect(result.rows[0].deletedAt).toBe('2026-09-01T00:00:00Z');
  expect(repository.rows.get('d1')?.payload).toBeNull();
});

test('offline writes remain in a durable outbox', async () => {
  const repository = createMemoryCloudRepository([], { offline: true });
  const mutation = mutationFixture({ mutationId: 'offline-1' });
  const result = await flushOutbox([mutation], repository);
  expect(result.pending).toEqual([mutation]);
  expect(result.syncPhase).toBe('pending');
});
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/account/syncEngine.test.ts`.
Expected: FAIL because repository and engine are absent.

- [ ] **Step 3: Implement repository and engine**

Define `CloudRepository` with `pull(ownerId, sinceRevision?)`, `applyMutation(mutation)`, and `verify(ownerId, expectedIds)`. `runInitialMigration` must: wait for hydration, copy the old snapshot, pull remote, retain remote conflicts, batch only missing local records, pull again, verify, then mark migration complete. `flushOutbox` removes a mutation only after the server acknowledges its `mutationId`.

Use exponential retry delays of 2s, 5s, 15s, 60s, then 5m; stop automatic retries for auth failures. A device last synced over 90 days ago must full-pull before any upload.

- [ ] **Step 4: Verify GREEN and commit**

Run `npm test -- tests/account/syncEngine.test.ts && npm run typecheck`.
Commit as `feat: add offline personal cloud sync engine`.

### Task 3B: Store photos and image stamps privately

- [ ] **Step 1: Write failing media tests**

Create `tests/account/personalMedia.test.ts` with an injected image processor and Storage gateway. Assert the processor is called before upload, object keys equal `user-1/<domain>/<uuid>.jpg`, database payloads contain only that key, signed URLs expire within 15 minutes, a failed upload stays retryable in the outbox, and deleting a record schedules the old object for cleanup.

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/account/personalMedia.test.ts`.
Expected: FAIL because `personalMedia.ts` does not exist.

- [ ] **Step 3: Implement private media handling**

Re-encode selected images through `expo-image-manipulator` as compressed JPEG before upload so original EXIF is not retained. Accept only image MIME types, cap processed output at 5 MB, use cryptographic UUID filenames, upload only inside the verified UID prefix, and return an object key rather than a public URL. Reads use short-lived signed URLs; replacement deletes the old object after the new database row succeeds.

- [ ] **Step 4: Verify GREEN and commit**

Run `npm test -- tests/account/personalMedia.test.ts && npm run typecheck`.
Commit as `feat: protect personal media backups`.

### Task 4: Create reproducible Supabase schema and RLS

- [ ] **Step 1: Write failing SQL contract checks**

Create `tests/account/migrationContracts.test.ts` that reads migrations and asserts every personal table contains `enable row level security`, an indexed `user_id uuid references auth.users(id) on delete cascade`, and policies using `(select auth.uid()) = user_id`. Assert public/anon privileges are revoked and no client-facing function is granted to `public`.

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/account/migrationContracts.test.ts`.
Expected: FAIL because migrations 000/005/006 do not exist.

- [ ] **Step 3: Add base and personal schema**

`000_group_base_schema.sql` creates the `groups`, `group_members`, and `shared_entries` columns consumed by the existing stores, using idempotent DDL. `005_personal_cloud.sql` creates `profiles`, `personal_calendar_entries`, `personal_special_dates`, `personal_preferences`, `personal_stamps`, and `sync_mutations`. Each sync row has `schema_version smallint`, `revision bigint`, `updated_at timestamptz`, and `deleted_at timestamptz`; payload fields use `jsonb` only where preserving the current aggregate shape is intentional.

Add foreign-key/RLS indexes, owner policies, a private `personal-media` bucket policy constrained to the first path segment matching `auth.uid()`, and an atomic `apply_personal_mutations(jsonb)` function with fixed `search_path=''` and service/authorized grants only.

- [ ] **Step 4: Add lifecycle schema**

`006_account_lifecycle.sql` creates `account_merge_intents`, `account_deletion_requests`, private Apple credential storage, restrictive policies that reject writes during deletion, and service-role-only RPCs for merge and deletion cleanup. Merge intents store only a hash of the nonce, expire after ten minutes, and are one-use.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- tests/account/migrationContracts.test.ts
git diff --check -- supabase
```

Commit migrations/tests as `feat: add personal cloud security schema`.

### Task 5: Implement backup login and callback flows

- [ ] **Step 1: Install Apple authentication**

Run `npx expo install expo-apple-authentication` and add its config plugin plus `ios.usesAppleSignIn=true`. Add the Sign in with Apple entitlement to the native target without using `expo prebuild --clean`.

- [ ] **Step 2: Write failing auth-flow tests**

Create `tests/account/authFlow.test.ts` around an injected `AuthGateway` and assert:

```ts
import { connectBackupIdentity } from '../../lib/account/connectBackupIdentity';
import { fakeAuthGateway } from './fixtures';

test('new provider identity links without changing anonymous UID', async () => {
  const gateway = fakeAuthGateway({ currentUserId: 'guest-1', linkResultUserId: 'guest-1' });
  const result = await connectBackupIdentity({ provider: 'google', gateway });
  expect(result).toEqual({ status: 'connected', userId: 'guest-1' });
  expect(gateway.calls).toContainEqual(['linkIdentity', 'google', ['openid', 'email', 'profile']]);
});

test('provider cancellation preserves the guest session', async () => {
  const gateway = fakeAuthGateway({ currentUserId: 'guest-1', oauthResult: 'cancelled' });
  await expect(connectBackupIdentity({ provider: 'google', gateway })).resolves.toEqual({ status: 'cancelled' });
  expect(gateway.calls).not.toContainEqual(['signOut']);
  expect(gateway.currentUserId).toBe('guest-1');
});

test('an already-owned identity creates a merge intent before session replacement', async () => {
  const gateway = fakeAuthGateway({ currentUserId: 'guest-1', identityAlreadyOwnedBy: 'account-9' });
  await connectBackupIdentity({ provider: 'google', gateway });
  expect(gateway.calls.slice(0, 2)).toEqual([
    ['startMerge', 'guest-1'],
    ['signInExistingIdentity', 'google', ['openid', 'email', 'profile']],
  ]);
});
```

- [ ] **Step 3: Verify RED**

Run `npm test -- tests/account/authFlow.test.ts`.
Expected: FAIL because account auth does not exist.

- [ ] **Step 4: Implement provider flows**

Use a dedicated `useAccountAuth` separate from every `useGoogleAuth*` Calendar file. Google uses Supabase hosted OAuth with PKCE and redirect `recoto://auth/callback`; web uses the same callback route. Native Apple uses `AppleAuthentication.signInAsync`, a cryptographic raw nonce and SHA-256 nonce, then `linkIdentity({ provider: 'apple', token, nonce })` for a new identity. Send Apple's authorization code to `store-apple-token` immediately; never persist it client-side.

When the identity is already owned, preserve the guest session, call `start-account-merge`, complete provider authentication, then call `complete-account-merge`; only switch owner after the server verifies and returns success.

- [ ] **Step 5: Add callback route and UI**

`app/auth/callback.tsx` accepts only `code`/expected OAuth error fields, exchanges PKCE code, validates state through the SDK, and navigates to Settings. `AccountBackupCard` shows local-only, syncing, synced, offline, reauth, and deletion-pending states. On iOS, render the official Apple button at the same visual prominence as Google.

- [ ] **Step 6: Verify GREEN and commit**

Run `npm test -- tests/account/authFlow.test.ts && npm run typecheck` and a web callback smoke test. Commit as `feat: add Google and Apple backup accounts`.

### Task 6: Implement restore, logout, and account deletion

- [ ] **Step 1: Write failing lifecycle tests**

Create `tests/account/accountLifecycle.test.ts` and assert:

```ts
import { createAccountLifecycleCoordinator } from '../../lib/account/accountLifecycle';
import { emptyPersonalSnapshot, fullPersonalSnapshot, lifecycleFixture } from './fixtures';

test('an empty cache restores all remote entities', async () => {
  const deps = lifecycleFixture({ remote: fullPersonalSnapshot(), local: emptyPersonalSnapshot() });
  const coordinator = createAccountLifecycleCoordinator(deps);
  await coordinator.restore('user-1');
  expect(deps.local.read('user-1')).toEqual(fullPersonalSnapshot());
});

test('local logout clears only that users cache and keeps cloud rows', async () => {
  const deps = lifecycleFixture({ remote: fullPersonalSnapshot(), local: fullPersonalSnapshot() });
  await createAccountLifecycleCoordinator(deps).logout('user-1');
  expect(deps.local.read('user-1')).toEqual(emptyPersonalSnapshot());
  expect(deps.repository.read('user-1')).toEqual(fullPersonalSnapshot());
});

test('failed deletion keeps local data and enters deletion-pending', async () => {
  const deps = lifecycleFixture({ deleteResult: { ok: false, retryable: true } });
  const result = await createAccountLifecycleCoordinator(deps).deleteAccount();
  expect(result.status).toBe('deletion-pending');
  expect(deps.local.read('user-1')).toEqual(fullPersonalSnapshot());
});

test('successful deletion clears cache outbox notifications and credentials', async () => {
  const deps = lifecycleFixture({ deleteResult: { ok: true } });
  await createAccountLifecycleCoordinator(deps).deleteAccount();
  expect(deps.local.read('user-1')).toEqual(emptyPersonalSnapshot());
  expect(deps.outbox.items).toEqual([]);
  expect(deps.notifications.cancelAll).toHaveBeenCalled();
  expect(deps.credentials.clear).toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/account/accountLifecycle.test.ts`.
Expected: FAIL until lifecycle coordinator exists.

- [ ] **Step 3: Implement Edge Functions**

Each function verifies `Authorization` using a user-scoped client and derives UID from the verified user, never the body. `delete-account` sets deletion pending, revokes Apple/Google tokens when present, enumerates and deletes UID-prefixed Storage objects through the Storage API, calls the service-only transactional cleanup RPC, and invokes `auth.admin.deleteUser(uid, false)` last. Every phase is idempotent and records a non-content audit timestamp.

- [ ] **Step 4: Implement client lifecycle UI**

`DeleteAccountSheet` shows exactly what is deleted, explains Google source events remain, requires a two-step destructive confirmation and same-provider reauthentication, then invokes the function. Do not clear the device until server success. After success, show a completion screen with an explicit `ゲストで再開` action rather than auto-creating an anonymous account.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm test -- tests/account/accountLifecycle.test.ts
npm run verify
```

Then run staging integration SQL with two users to prove cross-user reads/writes fail. If staging credentials are absent, record this item as an external release blocker without weakening local tests.

- [ ] **Step 6: Commit**

Stage the Edge Functions, lifecycle store/components, Settings integration, tests, and deployment docs explicitly. Commit as `feat: add account restore and in-app deletion`.
