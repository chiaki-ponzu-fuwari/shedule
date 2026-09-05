import type { BackupIdentityProvider } from './connectBackupIdentity';
import type {
  AccountDeletionReceipt,
  AccountDeletionStatus,
} from './accountDeletion';

interface AccountDeletionCoordinatorPort {
  begin(ownerId: string): Promise<AccountDeletionReceipt>;
  read(): Promise<AccountDeletionReceipt | null>;
  execute(input: {
    ownerId: string;
    reauthenticationToken?: string;
    googleProviderToken?: string;
  }): Promise<{
    status: 'completed';
    requestId: string;
    manualRevocationRequired: boolean;
  }>;
  recover(): Promise<AccountDeletionStatus | null>;
  acknowledgeCompleted(requestId: string): Promise<void>;
}

type ReauthenticationResult =
  | {
      status: 'reauthenticated';
      userId: string;
      accessToken: string;
      providerToken?: string;
    }
  | { status: 'cancelled' };

export interface AccountDeletionControllerDependencies {
  deletion: AccountDeletionCoordinatorPort;
  reauthenticate(
    provider: BackupIdentityProvider,
    expectedUserId: string,
  ): Promise<ReauthenticationResult>;
  cleanup(ownerId: string): Promise<{ complete: boolean; errors: string[] }>;
  markDeletionPending(): void;
  markError(message: string): void;
}

export type AccountDeletionControllerResult =
  | { status: 'none' | 'cancelled' | 'confirmation-required' }
  | {
      status: 'deleted';
      requestId: string;
      manualRevocationRequired: boolean;
    }
  | { status: 'deletion-pending'; requestId?: string; error: string }
  | { status: 'local-cleanup-pending'; requestId: string; errors: string[] };

function safeError(_error: unknown): string {
  // OAuth, provider, and database failures can include private identifiers.
  // The UI only needs a stable retry instruction.
  return 'Account deletion could not be completed. Please retry.';
}

export function createAccountDeletionController(
  dependencies: AccountDeletionControllerDependencies,
) {
  let inFlight: Promise<AccountDeletionControllerResult> | null = null;

  async function finishLocalCleanup(
    ownerId: string,
    requestId: string,
    manualRevocationRequired: boolean,
    shouldMarkPending = true,
  ): Promise<AccountDeletionControllerResult> {
    if (shouldMarkPending) dependencies.markDeletionPending();
    const cleanup = await dependencies.cleanup(ownerId);
    if (!cleanup.complete) {
      return {
        status: 'local-cleanup-pending',
        requestId,
        errors: cleanup.errors,
      };
    }
    await dependencies.deletion.acknowledgeCompleted(requestId);
    return { status: 'deleted', requestId, manualRevocationRequired };
  }

  function singleFlight(
    operation: () => Promise<AccountDeletionControllerResult>,
  ): Promise<AccountDeletionControllerResult> {
    if (inFlight) return inFlight;
    const promise = operation();
    inFlight = promise;
    void promise.finally(() => {
      if (inFlight === promise) inFlight = null;
    }).catch(() => undefined);
    return promise;
  }

  return {
    deleteAccount(input: {
      ownerId: string;
      provider: BackupIdentityProvider | null;
    }): Promise<AccountDeletionControllerResult> {
      return singleFlight(async () => {
        let requestId: string | undefined;
        try {
          const receipt = await dependencies.deletion.begin(input.ownerId);
          requestId = receipt.requestId;

          let reauthenticationToken: string | undefined;
          let googleProviderToken: string | undefined;
          if (input.provider) {
            const verified = await dependencies.reauthenticate(
              input.provider,
              input.ownerId,
            );
            if (verified.status === 'cancelled') return { status: 'cancelled' };
            if (verified.userId !== input.ownerId) {
              throw new Error('Reauthenticated account did not match the account being deleted');
            }
            reauthenticationToken = verified.accessToken;
            googleProviderToken = verified.providerToken;
          }

          dependencies.markDeletionPending();
          const deleted = await dependencies.deletion.execute({
            ownerId: input.ownerId,
            ...(reauthenticationToken ? { reauthenticationToken } : {}),
            ...(googleProviderToken ? { googleProviderToken } : {}),
          });
          return finishLocalCleanup(
            input.ownerId,
            deleted.requestId,
            deleted.manualRevocationRequired,
            false,
          );
        } catch (error) {
          const message = safeError(error);
          dependencies.markError(message);
          return {
            status: 'deletion-pending',
            ...(requestId ? { requestId } : {}),
            error: message,
          };
        }
      });
    },

    recover(): Promise<AccountDeletionControllerResult> {
      return singleFlight(async () => {
        const receipt = await dependencies.deletion.read();
        if (!receipt) return { status: 'none' };
        if (receipt.stage === 'completed') {
          return finishLocalCleanup(
            receipt.ownerId,
            receipt.requestId,
            receipt.manualRevocationRequired,
          );
        }
        try {
          const status = await dependencies.deletion.recover();
          if (!status || status.status === 'challenged') {
            return { status: 'confirmation-required' };
          }
          if (status.status === 'completed') {
            return finishLocalCleanup(
              receipt.ownerId,
              receipt.requestId,
              status.manualRevocationRequired,
            );
          }
          if (!status.retryable) {
            return { status: 'confirmation-required' };
          }
          dependencies.markDeletionPending();
          const deleted = await dependencies.deletion.execute({ ownerId: receipt.ownerId });
          return finishLocalCleanup(
            receipt.ownerId,
            deleted.requestId,
            deleted.manualRevocationRequired,
            false,
          );
        } catch (error) {
          const message = safeError(error);
          dependencies.markDeletionPending();
          return {
            status: 'deletion-pending',
            requestId: receipt.requestId,
            error: message,
          };
        }
      });
    },
  };
}
