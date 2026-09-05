import { useMemo } from 'react';
import { Platform } from 'react-native';
import { makeRedirectUri } from 'expo-auth-session';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { connectBackupIdentity, type BackupIdentityProvider } from '../lib/account/connectBackupIdentity';
import { createAccountAuthController } from '../lib/account/accountAuthController';
import {
  AccountAuthError,
  createSupabaseAuthGateway,
  createTransientSupabaseAuthClient,
  type AccountAuthClient,
  type AccountAuthGatewayDependencies,
} from '../lib/account/supabaseAuthGateway';
import {
  createOAuthGlobalLockForPlatform,
  createOAuthOperationJournal,
  type OAuthOperationJournal,
} from '../lib/account/oauthOperationJournal';
import { getAccountOperationStorage, getSupabaseClient } from '../lib/supabase';
import { useAccountStore } from '../store/accountStore';
import { useAppSessionStore } from '../store/appSessionStore';

function accountRedirectUri() {
  return makeRedirectUri({ scheme: 'recoto', path: 'auth/callback' });
}

let productionOperationJournal: OAuthOperationJournal | null = null;

export function getAccountOAuthOperationJournal() {
  if (!productionOperationJournal) {
    const withGlobalLock = createOAuthGlobalLockForPlatform(
      Platform.OS === 'web' ? 'web' : 'native',
    );
    productionOperationJournal = createOAuthOperationJournal({
      storage: getAccountOperationStorage(),
      randomUUID: () => Crypto.randomUUID(),
      ...(withGlobalLock ? { withGlobalLock } : {}),
    });
  }
  return productionOperationJournal;
}

export function createProductionAccountAuthGateway(): ReturnType<typeof createSupabaseAuthGateway> {
  const main = getSupabaseClient();
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? '';
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '';
  if (!main || !url || !anonKey) {
    throw new AccountAuthError(
      'configuration',
      'データ保存用ログインの接続設定が未完了です。端末内の予定はそのまま使えます。',
    );
  }

  const redirectUri = accountRedirectUri();
  const operationStorage = getAccountOperationStorage();
  const withOAuthCallbackLock = createOAuthGlobalLockForPlatform(
    Platform.OS === 'web' ? 'web' : 'native',
  );
  const dependencies: AccountAuthGatewayDependencies = {
    mainClient: main as unknown as AccountAuthClient,
    createTransientClient: (storageKey) =>
      createTransientSupabaseAuthClient(
        url,
        anonKey,
        storageKey,
        operationStorage,
      ),
    clearTransientStorage: async (storageKey) => {
      await operationStorage.removeItem(storageKey);
      await operationStorage.removeItem(`${storageKey}-code-verifier`);
    },
    operationJournal: getAccountOAuthOperationJournal(),
    ...(withOAuthCallbackLock ? { withOAuthCallbackLock } : {}),
    platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
    redirectUri,
    openAuthSession: async (authorizeUrl, returnUrl) => {
      const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, returnUrl);
      return result.type === 'success' && result.url
        ? { type: 'success', url: result.url }
        : { type: result.type === 'dismiss' ? 'dismiss' : 'cancel' };
    },
    randomUUID: () => Crypto.randomUUID(),
    sha256: (value) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
    nativeApple: {
      isAvailable: () => AppleAuthentication.isAvailableAsync(),
      signIn: async ({ nonce, state, requestedScopes }) => {
        const result = await AppleAuthentication.signInAsync({
          nonce,
          state,
          requestedScopes: [...requestedScopes],
        });
        return {
          identityToken: result.identityToken,
          authorizationCode: result.authorizationCode,
          state: result.state,
        };
      },
    },
  };
  return createSupabaseAuthGateway(dependencies);
}

let accountAuthResumeInFlight: ReturnType<
  ReturnType<typeof createSupabaseAuthGateway>['resumePendingOperation']
> | null = null;

export function resumePendingAccountAuthOperation() {
  if (accountAuthResumeInFlight) return accountAuthResumeInFlight;
  const operation = createProductionAccountAuthGateway().resumePendingOperation();
  accountAuthResumeInFlight = operation;
  void operation.finally(() => {
    if (accountAuthResumeInFlight === operation) accountAuthResumeInFlight = null;
  }).catch(() => undefined);
  return operation;
}

async function readVerifiedMainUser() {
  const client = getSupabaseClient();
  if (!client) {
    throw new AccountAuthError('configuration', 'クラウドの接続設定が未完了です。');
  }
  const { data, error } = await client.auth.getUser();
  if (error || !data.user?.id) {
    throw new AccountAuthError(
      'reauth-required',
      'クラウド保存を続けるには、もう一度ログインが必要です。',
    );
  }
  return { id: data.user.id, email: data.user.email ?? null };
}

/** Separate from useGoogleAuth: this requests only identity scopes for backup. */
export function useAccountAuth() {
  const ensureGuestSession = useAppSessionStore((state) => state.ensureGuestSession);
  const beginConnection = useAccountStore((state) => state.beginConnection);
  const cancelConnection = useAccountStore((state) => state.cancelConnection);
  const markConnected = useAccountStore((state) => state.markConnected);
  const markOffline = useAccountStore((state) => state.markOffline);
  const markReauthRequired = useAccountStore((state) => state.markReauthRequired);
  const markError = useAccountStore((state) => state.markError);

  return useMemo(
    () =>
      createAccountAuthController({
        ensureGuestSession,
        connectIdentity: async (provider) =>
          connectBackupIdentity({ provider, gateway: createProductionAccountAuthGateway() }),
        reauthenticateIdentity: async (provider, expectedUserId) =>
          createProductionAccountAuthGateway().reauthenticate(provider, expectedUserId),
        readConnectedUser: readVerifiedMainUser,
        account: {
          beginConnection,
          cancelConnection,
          markConnected,
          markOffline,
          markReauthRequired,
          markError,
        },
      }),
    [
      beginConnection,
      cancelConnection,
      ensureGuestSession,
      markConnected,
      markError,
      markOffline,
      markReauthRequired,
    ],
  );
}

export const accountAuthRedirectUri = accountRedirectUri;
