import type { PersonalSnapshot } from '../../types/account';

export type AccountLifecycleState =
  | 'restoring'
  | 'ready'
  | 'signing-out'
  | 'signed-out'
  | 'deleting'
  | 'deletion-pending'
  | 'deleted'
  | 'error';

export interface RemoteAccountDeletionResult {
  ok: boolean;
  retryable?: boolean;
  requestId?: string;
  error?: string;
}

export interface AccountLifecycleDependencies {
  remote: {
    readSnapshot(ownerId: string): Promise<PersonalSnapshot>;
    deleteAccount(reauthenticationProof: string): Promise<RemoteAccountDeletionResult>;
  };
  local: {
    /** Must commit the full replacement or leave the previous cache untouched. */
    replaceAtomically(ownerId: string, snapshot: PersonalSnapshot): Promise<void>;
    clear(ownerId: string): Promise<void>;
  };
  outbox: { clear(ownerId: string): Promise<void> };
  notifications: { cancelAll(ownerId: string): Promise<void> };
  credentials: { clear(ownerId: string): Promise<void> };
  session: {
    clear(): Promise<void>;
    /** Deliberately not called automatically after logout or account deletion. */
    createAnonymous(): Promise<void>;
  };
  setLifecycleState(state: AccountLifecycleState): void;
}

export type DeleteAccountResult =
  | { status: 'deleted'; requestId?: string }
  | { status: 'deletion-pending'; requestId?: string; error: string }
  | { status: 'local-cleanup-pending'; requestId?: string; errors: string[] }
  | { status: 'deletion-failed'; requestId?: string; error: string };

function cloneSnapshot(snapshot: PersonalSnapshot): PersonalSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as PersonalSnapshot;
}

async function clearLocalAccountSurfaces(
  dependencies: AccountLifecycleDependencies,
  ownerId: string,
): Promise<string[]> {
  const tasks: Array<[string, () => Promise<void>]> = [
    ['local-cache', () => dependencies.local.clear(ownerId)],
    ['outbox', () => dependencies.outbox.clear(ownerId)],
    ['notifications', () => dependencies.notifications.cancelAll(ownerId)],
    ['credentials', () => dependencies.credentials.clear(ownerId)],
    ['session', () => dependencies.session.clear()],
  ];
  const results = await Promise.allSettled(tasks.map(([, task]) => task()));
  return results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [];
    const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return [`${tasks[index][0]}: ${detail}`];
  });
}

export function createAccountLifecycleCoordinator(
  dependencies: AccountLifecycleDependencies,
) {
  return {
    async restore(ownerId: string): Promise<PersonalSnapshot> {
      if (!ownerId.trim()) throw new Error('A verified account owner is required for restore');
      dependencies.setLifecycleState('restoring');
      try {
        const remoteSnapshot = await dependencies.remote.readSnapshot(ownerId);
        const replacement = cloneSnapshot(remoteSnapshot);
        await dependencies.local.replaceAtomically(ownerId, replacement);
        dependencies.setLifecycleState('ready');
        return cloneSnapshot(replacement);
      } catch (error) {
        dependencies.setLifecycleState('error');
        throw error;
      }
    },

    async logout(ownerId: string): Promise<void> {
      if (!ownerId.trim()) throw new Error('A verified account owner is required for logout');
      dependencies.setLifecycleState('signing-out');
      const failures = await clearLocalAccountSurfaces(dependencies, ownerId);
      if (failures.length > 0) {
        dependencies.setLifecycleState('error');
        throw new Error(`Local account cleanup failed (${failures.join('; ')})`);
      }
      dependencies.setLifecycleState('signed-out');
    },

    async deleteAccount(input: {
      ownerId: string;
      reauthenticationProof: string;
    }): Promise<DeleteAccountResult> {
      if (!input.ownerId.trim()) throw new Error('A verified account owner is required for deletion');
      if (!input.reauthenticationProof.trim()) {
        throw new Error('Fresh reauthentication is required before account deletion');
      }

      dependencies.setLifecycleState('deleting');
      const remoteResult = await dependencies.remote.deleteAccount(input.reauthenticationProof);
      if (!remoteResult.ok) {
        const error = remoteResult.error ?? 'Account deletion could not be completed';
        if (remoteResult.retryable) {
          dependencies.setLifecycleState('deletion-pending');
          return {
            status: 'deletion-pending',
            ...(remoteResult.requestId ? { requestId: remoteResult.requestId } : {}),
            error,
          };
        }
        dependencies.setLifecycleState('error');
        return {
          status: 'deletion-failed',
          ...(remoteResult.requestId ? { requestId: remoteResult.requestId } : {}),
          error,
        };
      }

      const cleanupErrors = await clearLocalAccountSurfaces(dependencies, input.ownerId);
      if (cleanupErrors.length > 0) {
        dependencies.setLifecycleState('deletion-pending');
        return {
          status: 'local-cleanup-pending',
          ...(remoteResult.requestId ? { requestId: remoteResult.requestId } : {}),
          errors: cleanupErrors,
        };
      }

      dependencies.setLifecycleState('deleted');
      return {
        status: 'deleted',
        ...(remoteResult.requestId ? { requestId: remoteResult.requestId } : {}),
      };
    },
  };
}
