import type { BackupIdentityProvider } from './connectBackupIdentity';
import type {
  CloudRepository,
  CloudRow,
  CloudRowSeed,
} from './cloudRepository';
import type { DataOwner } from './namespacedStorage';
import {
  isAuthFailure,
  runInitialMigration,
  type MigrationCompletion,
} from './syncEngine';

export type AccountBootstrapIdentity =
  | { kind: 'guest-local' }
  | { kind: 'anonymous'; userId: string }
  | {
      kind: 'account';
      userId: string;
      provider: BackupIdentityProvider;
      email: string | null;
    }
  | {
      kind: 'reauth-required-account';
      userId: string;
      provider: BackupIdentityProvider;
      email: string | null;
    }
  | { kind: 'verification-failed'; error: unknown };

export type AccountBootstrapGate =
  | { status: 'bootstrapping' }
  | { status: 'ready'; ownerId: string }
  | { status: 'safe-failure'; ownerId: string; message: string }
  | { status: 'blocked'; message: string };

export type AccountBootstrapResult =
  | AccountBootstrapGate
  | { status: 'superseded' };

export interface AccountBootstrapTransition {
  targetUserId: string;
  /** Present only for a first guest-to-account migration. */
  sourceRows: CloudRowSeed[] | null;
}

export interface AccountBootstrapBinding {
  activeAccountId: string | null;
  pendingTransition: AccountBootstrapTransition | null;
}

export interface AccountBootstrapPersistence {
  readBinding(): Promise<AccountBootstrapBinding>;
  beginTransition(transition: AccountBootstrapTransition): Promise<void>;
  completeTransition(userId: string): Promise<void>;
  clearAccountBinding(): Promise<void>;
  /** Finishes an interrupted multi-key cache commit before the cache is read. */
  recoverOwner(ownerId: string): Promise<void>;
  readLocalRows(owner: DataOwner): Promise<CloudRowSeed[]>;
  /** Copies a first-time guest snapshot into the selected account cache before networking. */
  stageSourceRows(ownerId: string, rows: readonly CloudRowSeed[]): Promise<void>;
  persistLocalBackup(ownerId: string, rows: readonly CloudRow[]): Promise<void>;
  commitMigration(ownerId: string, completion: MigrationCompletion): Promise<void>;
}

export interface AccountBootstrapOutboxResult {
  syncPhase: 'synced' | 'pending' | 'reauth-required' | 'error';
}

export interface AccountBootstrapOutbox {
  flush(ownerId: string, repository: CloudRepository): Promise<AccountBootstrapOutboxResult>;
}

export interface AccountOwnerPort {
  getCurrentOwner(): Promise<DataOwner>;
  getInstallationGuestOwner(): Promise<DataOwner>;
  switchOwnerAndRehydrate(owner: DataOwner): Promise<void>;
}

export interface AccountBootstrapAccountPort {
  resetToGuest(): void;
  setGuestConnected(userId: string): void;
  markConnected(details: {
    userId: string;
    provider: BackupIdentityProvider;
    email: string | null;
  }): void;
  markSyncing(): void;
  markSynced(at: string): void;
  markConflictBackedUp(at: string): void;
  markOffline(message: string): void;
  markReauthRequired(message?: string): void;
  markError(message: string): void;
}

export interface AccountBootstrapDependencies {
  owners: AccountOwnerPort;
  persistence: AccountBootstrapPersistence;
  outbox: AccountBootstrapOutbox;
  /** null means the cloud client is not configured; it must never be treated as synced. */
  repository: CloudRepository | null;
  account: AccountBootstrapAccountPort;
  now?: () => Date;
  onGateChange?: (gate: AccountBootstrapGate) => void;
}

const CLOUD_UNAVAILABLE =
  'クラウド保存を確認できませんでした。この端末のデータはそのまま使えます。';
const OWNER_SWITCH_FAILED =
  '安全にデータを切り替えられませんでした。再試行してください。';
const VERIFICATION_FAILED =
  'ログイン情報を確認できませんでした。通信を確認して再試行してください。';

class SupersededBootstrap extends Error {}

function cloneRows(rows: readonly CloudRowSeed[]): CloudRowSeed[] {
  return rows.map((row) => ({
    ...row,
    payload: row.payload === null
      ? null
      : JSON.parse(JSON.stringify(row.payload)) as Record<string, unknown>,
  }));
}

function identityKey(identity: AccountBootstrapIdentity): string {
  switch (identity.kind) {
    case 'guest-local': return 'guest-local';
    case 'anonymous': return `anonymous:${identity.userId}`;
    case 'account': return `account:${identity.userId}`;
    case 'reauth-required-account': return `reauth-required-account:${identity.userId}`;
    case 'verification-failed': return 'verification-failed';
  }
}

function errorDetail(_error: unknown, fallback: string): string {
  // Provider, storage, and SQL errors can contain internal identifiers or
  // credentials. Keep those details in server diagnostics, never UI state.
  return fallback;
}

export function createAccountBootstrapCoordinator(
  dependencies: AccountBootstrapDependencies,
) {
  const now = dependencies.now ?? (() => new Date());
  let gate: AccountBootstrapGate = { status: 'bootstrapping' };
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  let inFlight: { key: string; promise: Promise<AccountBootstrapResult> } | null = null;
  let settledKey: string | null = null;

  const publish = (next: AccountBootstrapGate) => {
    gate = next;
    dependencies.onGateChange?.({ ...next });
  };

  const assertCurrent = (startedAtGeneration: number) => {
    if (startedAtGeneration !== generation) throw new SupersededBootstrap();
  };

  const failAccountSync = (
    error: unknown,
    ownerId: string,
    startedAtGeneration: number,
  ): AccountBootstrapResult => {
    assertCurrent(startedAtGeneration);
    const message = errorDetail(error, CLOUD_UNAVAILABLE);
    if (isAuthFailure(error)) dependencies.account.markReauthRequired(VERIFICATION_FAILED);
    else if (
      error instanceof Error
      && 'retryable' in error
      && (error as Error & { retryable?: unknown }).retryable === true
    ) {
      dependencies.account.markOffline(CLOUD_UNAVAILABLE);
    } else {
      dependencies.account.markError(message);
    }
    const result: AccountBootstrapGate = { status: 'safe-failure', ownerId, message };
    publish(result);
    return result;
  };

  const selectGuest = async (
    identity: Extract<AccountBootstrapIdentity, { kind: 'guest-local' | 'anonymous' }>,
    startedAtGeneration: number,
  ): Promise<AccountBootstrapResult> => {
    const guestOwner = await dependencies.owners.getInstallationGuestOwner();
    assertCurrent(startedAtGeneration);
    await dependencies.owners.switchOwnerAndRehydrate(guestOwner);
    assertCurrent(startedAtGeneration);
    await dependencies.persistence.clearAccountBinding();
    assertCurrent(startedAtGeneration);

    if (identity.kind === 'anonymous') {
      dependencies.account.setGuestConnected(identity.userId);
    } else {
      dependencies.account.resetToGuest();
    }
    const result: AccountBootstrapGate = { status: 'ready', ownerId: guestOwner.id };
    settledKey = identityKey(identity);
    publish(result);
    return result;
  };

  const selectAccount = async (
    identity: Extract<AccountBootstrapIdentity, { kind: 'account' }>,
    startedAtGeneration: number,
  ): Promise<AccountBootstrapResult> => {
    let ownerCacheSafe = false;
    try {
      const binding = await dependencies.persistence.readBinding();
      assertCurrent(startedAtGeneration);
      const currentOwner = await dependencies.owners.getCurrentOwner();
      assertCurrent(startedAtGeneration);

      const resumable = binding.pendingTransition?.targetUserId === identity.userId
        ? binding.pendingTransition
        : null;
      let sourceRows = resumable?.sourceRows ? cloneRows(resumable.sourceRows) : null;
      if (!resumable && binding.activeAccountId === null && currentOwner.kind === 'guest') {
        sourceRows = cloneRows(await dependencies.persistence.readLocalRows(currentOwner));
        assertCurrent(startedAtGeneration);
      }
      if (!resumable) {
        await dependencies.persistence.beginTransition({
          targetUserId: identity.userId,
          sourceRows,
        });
        assertCurrent(startedAtGeneration);
      }

      const targetOwner: DataOwner = { kind: 'user', id: identity.userId };
      await dependencies.owners.switchOwnerAndRehydrate(targetOwner);
      assertCurrent(startedAtGeneration);
      await dependencies.persistence.recoverOwner(identity.userId);
      assertCurrent(startedAtGeneration);
      if (sourceRows) {
        await dependencies.persistence.stageSourceRows(identity.userId, sourceRows);
        assertCurrent(startedAtGeneration);
      }
      ownerCacheSafe = true;

      dependencies.account.markConnected({
        userId: identity.userId,
        provider: identity.provider,
        email: identity.email,
      });
      dependencies.account.markSyncing();

      if (!dependencies.repository) {
        throw new Error(CLOUD_UNAVAILABLE);
      }

      const localRows = sourceRows
        ?? await dependencies.persistence.readLocalRows(targetOwner);
      assertCurrent(startedAtGeneration);
      const migration = await runInitialMigration({
        ownerId: identity.userId,
        localRows,
        repository: dependencies.repository,
        waitForHydration: async () => undefined,
        persistLocalBackup: (rows) =>
          dependencies.persistence.persistLocalBackup(identity.userId, rows),
        markMigrationComplete: (completion) =>
          dependencies.persistence.commitMigration(identity.userId, completion),
      });
      assertCurrent(startedAtGeneration);

      const outbox = await dependencies.outbox.flush(identity.userId, dependencies.repository);
      assertCurrent(startedAtGeneration);
      if (outbox.syncPhase !== 'synced') {
        if (outbox.syncPhase === 'reauth-required') {
          dependencies.account.markReauthRequired();
        } else if (outbox.syncPhase === 'pending') {
          dependencies.account.markOffline(CLOUD_UNAVAILABLE);
        } else {
          dependencies.account.markError(CLOUD_UNAVAILABLE);
        }
        const result: AccountBootstrapGate = {
          status: 'safe-failure',
          ownerId: identity.userId,
          message: CLOUD_UNAVAILABLE,
        };
        publish(result);
        return result;
      }

      await dependencies.persistence.completeTransition(identity.userId);
      assertCurrent(startedAtGeneration);
      const syncedAt = now().toISOString();
      if (migration.syncPhase === 'conflict-backed-up') {
        dependencies.account.markConflictBackedUp(syncedAt);
      } else {
        dependencies.account.markSynced(syncedAt);
      }
      const result: AccountBootstrapGate = { status: 'ready', ownerId: identity.userId };
      settledKey = identityKey(identity);
      publish(result);
      return result;
    } catch (error) {
      if (error instanceof SupersededBootstrap) return { status: 'superseded' };
      if (startedAtGeneration !== generation) return { status: 'superseded' };
      if (ownerCacheSafe) {
        return failAccountSync(error, identity.userId, startedAtGeneration);
      }
      dependencies.account.markError(errorDetail(error, OWNER_SWITCH_FAILED));
      const result: AccountBootstrapGate = {
        status: 'blocked',
        message: OWNER_SWITCH_FAILED,
      };
      publish(result);
      return result;
    }
  };

  const selectReauthenticationRequired = async (
    identity: Extract<AccountBootstrapIdentity, { kind: 'reauth-required-account' }>,
    startedAtGeneration: number,
  ): Promise<AccountBootstrapResult> => {
    try {
      const binding = await dependencies.persistence.readBinding();
      assertCurrent(startedAtGeneration);
      const currentOwner = await dependencies.owners.getCurrentOwner();
      assertCurrent(startedAtGeneration);
      const ownsAccountCache = binding.activeAccountId === identity.userId
        || binding.pendingTransition?.targetUserId === identity.userId
        || (currentOwner.kind === 'user' && currentOwner.id === identity.userId);
      const owner = ownsAccountCache
        ? { kind: 'user' as const, id: identity.userId }
        : await dependencies.owners.getInstallationGuestOwner();
      assertCurrent(startedAtGeneration);
      await dependencies.owners.switchOwnerAndRehydrate(owner);
      assertCurrent(startedAtGeneration);
      if (owner.kind === 'user') {
        await dependencies.persistence.recoverOwner(identity.userId);
        assertCurrent(startedAtGeneration);
      }
      dependencies.account.markConnected({
        userId: identity.userId,
        provider: identity.provider,
        email: identity.email,
      });
      dependencies.account.markReauthRequired(
        'クラウド保存を続けるには、Appleで再ログインしてください。',
      );
      const result: AccountBootstrapGate = {
        status: 'safe-failure',
        ownerId: owner.id,
        message: VERIFICATION_FAILED,
      };
      settledKey = identityKey(identity);
      publish(result);
      return result;
    } catch (error) {
      if (error instanceof SupersededBootstrap || startedAtGeneration !== generation) {
        return { status: 'superseded' };
      }
      dependencies.account.markError(errorDetail(error, OWNER_SWITCH_FAILED));
      const result: AccountBootstrapGate = { status: 'blocked', message: OWNER_SWITCH_FAILED };
      publish(result);
      return result;
    }
  };

  const process = async (
    identity: AccountBootstrapIdentity,
    startedAtGeneration: number,
  ): Promise<AccountBootstrapResult> => {
    try {
      assertCurrent(startedAtGeneration);
      if (identity.kind === 'verification-failed') {
        dependencies.account.markReauthRequired(VERIFICATION_FAILED);
        const result: AccountBootstrapGate = {
          status: 'blocked',
          message: VERIFICATION_FAILED,
        };
        publish(result);
        return result;
      }
      if (identity.kind === 'guest-local' || identity.kind === 'anonymous') {
        return await selectGuest(identity, startedAtGeneration);
      }
      if (identity.kind === 'reauth-required-account') {
        return await selectReauthenticationRequired(identity, startedAtGeneration);
      }
      return await selectAccount(identity, startedAtGeneration);
    } catch (error) {
      if (error instanceof SupersededBootstrap || startedAtGeneration !== generation) {
        return { status: 'superseded' };
      }
      dependencies.account.markError(errorDetail(error, OWNER_SWITCH_FAILED));
      const result: AccountBootstrapGate = { status: 'blocked', message: OWNER_SWITCH_FAILED };
      publish(result);
      return result;
    }
  };

  return {
    getGate: () => ({ ...gate }) as AccountBootstrapGate,

    /** Invalidates in-flight owner work as soon as an unverified auth event arrives. */
    invalidate() {
      generation += 1;
      settledKey = null;
      inFlight = null;
      publish({ status: 'bootstrapping' });
    },

    observe(identity: AccountBootstrapIdentity): Promise<AccountBootstrapResult> {
      const key = identityKey(identity);
      if (inFlight?.key === key) return inFlight.promise;
      if (settledKey === key && (gate.status === 'ready' || gate.status === 'safe-failure')) {
        return Promise.resolve({ ...gate } as AccountBootstrapGate);
      }

      generation += 1;
      const startedAtGeneration = generation;
      publish({ status: 'bootstrapping' });
      const promise = queue.then(() => process(identity, startedAtGeneration));
      queue = promise.then(() => undefined, () => undefined);
      inFlight = { key, promise };
      void promise.finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
      return promise;
    },
  };
}
