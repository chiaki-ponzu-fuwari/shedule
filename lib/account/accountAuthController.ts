import type { ConnectBackupIdentityResult, BackupIdentityProvider } from './connectBackupIdentity';
import { AccountAuthError, accountAuthUserMessage } from './supabaseAuthGateway';

interface ConnectedAccountDetails {
  userId: string;
  provider: BackupIdentityProvider;
  email: string | null;
}

interface AccountControllerActions {
  beginConnection(provider: BackupIdentityProvider): void;
  cancelConnection(): void;
  markConnected(details: ConnectedAccountDetails): void;
  markOffline(message: string): void;
  markReauthRequired(message?: string): void;
  markError(message: string): void;
}

export interface AccountAuthControllerDependencies {
  ensureGuestSession(reason: 'account-link'): Promise<string>;
  connectIdentity(provider: BackupIdentityProvider): Promise<ConnectBackupIdentityResult>;
  reauthenticateIdentity(
    provider: BackupIdentityProvider,
    expectedUserId: string,
  ): Promise<
    | {
        status: 'reauthenticated';
        userId: string;
        accessToken: string;
        providerToken?: string;
      }
    | { status: 'cancelled' }
  >;
  readConnectedUser(): Promise<{ id: string; email: string | null }>;
  account: AccountControllerActions;
}

export function createAccountAuthController(dependencies: AccountAuthControllerDependencies) {
  let inFlight: Promise<ConnectBackupIdentityResult> | null = null;
  let reauthInFlight: ReturnType<AccountAuthControllerDependencies['reauthenticateIdentity']> | null = null;

  function showFailure(error: unknown) {
    const message = accountAuthUserMessage(error);
    if (error instanceof AccountAuthError && error.code === 'reauth-required') {
      dependencies.account.markReauthRequired(message);
    } else if (error instanceof AccountAuthError && error.code === 'offline') {
      dependencies.account.markOffline(message);
    } else {
      dependencies.account.markError(message);
    }
  }

  const connect = (provider: BackupIdentityProvider) => {
    if (inFlight) return inFlight;

    const operation = (async () => {
      dependencies.account.beginConnection(provider);
      try {
        await dependencies.ensureGuestSession('account-link');
        const result = await dependencies.connectIdentity(provider);
        if (result.status === 'cancelled') {
          dependencies.account.cancelConnection();
          return result;
        }

        const user = await dependencies.readConnectedUser();
        if (user.id !== result.userId) {
          throw new AccountAuthError(
            'invalid-provider-response',
            '認証されたアカウントを確認できませんでした。',
          );
        }
        dependencies.account.markConnected({
          userId: user.id,
          provider,
          email: user.email,
        });
        return result;
      } catch (error) {
        showFailure(error);
        throw error;
      }
    })();

    inFlight = operation;
    void operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    }).catch(() => undefined);
    return operation;
  };

  const reauthenticate = (provider: BackupIdentityProvider, expectedUserId: string) => {
    if (reauthInFlight) return reauthInFlight;

    const operation = (async () => {
      dependencies.account.beginConnection(provider);
      try {
        const result = await dependencies.reauthenticateIdentity(provider, expectedUserId);
        if (result.status === 'cancelled') {
          dependencies.account.cancelConnection();
          return result;
        }
        if (result.userId !== expectedUserId) {
          throw new AccountAuthError(
            'invalid-provider-response',
            '再認証したアカウントが接続済みアカウントと一致しません。',
          );
        }
        const user = await dependencies.readConnectedUser();
        if (user.id !== expectedUserId) {
          throw new AccountAuthError(
            'invalid-provider-response',
            '再認証後のアカウントを確認できませんでした。',
          );
        }
        dependencies.account.markConnected({
          userId: user.id,
          provider,
          email: user.email,
        });
        return result;
      } catch (error) {
        showFailure(error);
        throw error;
      }
    })();

    reauthInFlight = operation;
    void operation.finally(() => {
      if (reauthInFlight === operation) reauthInFlight = null;
    }).catch(() => undefined);
    return operation;
  };

  return { connect, reauthenticate };
}
