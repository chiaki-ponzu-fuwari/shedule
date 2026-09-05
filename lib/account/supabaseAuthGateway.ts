import { createClient } from '@supabase/supabase-js';
import type {
  AuthGateway,
  BackupIdentityProvider,
  ExistingProviderSession,
  LinkIdentityResult,
  MergeIntent,
} from './connectBackupIdentity';
import {
  createOAuthOperationJournal,
  type OAuthOperationGlobalLock,
  type OAuthOperationJournal,
  type OAuthOperationRecord,
} from './oauthOperationJournal';
import {
  createProviderTokenStrippingStorage,
  type SupabaseAuthStorage,
} from '../supabaseAuthStorage';

type AuthErrorLike = { code?: string; message: string };
type AccountAuthUser = {
  id: string;
  email?: string | null;
  is_anonymous?: boolean;
  identities?: Array<{ provider?: string | null }> | null;
};
export type AccountAuthSession = {
  access_token: string;
  refresh_token: string;
  provider_token?: string | null;
  user: AccountAuthUser;
};

type HostedCredentials = {
  provider: BackupIdentityProvider;
  options: {
    redirectTo: string;
    scopes?: string;
    skipBrowserRedirect: true;
  };
};

type IdTokenCredentials = {
  provider: 'apple';
  token: string;
  nonce: string;
};

type AuthResponse = {
  data: { user: AccountAuthUser | null; session: AccountAuthSession | null };
  error: AuthErrorLike | null;
};

type HostedResponse = {
  data: { provider: string; url: string | null };
  error: AuthErrorLike | null;
};

export interface AccountAuthClient {
  auth: {
    getUser(): Promise<{
      data: { user: AccountAuthUser | null };
      error: AuthErrorLike | null;
    }>;
    getSession(): Promise<{
      data: { session: AccountAuthSession | null };
      error: AuthErrorLike | null;
    }>;
    linkIdentity(credentials: HostedCredentials | IdTokenCredentials): Promise<HostedResponse | AuthResponse>;
    signInWithOAuth(credentials: HostedCredentials): Promise<HostedResponse>;
    exchangeCodeForSession(code: string): Promise<AuthResponse>;
    signInWithIdToken(credentials: IdTokenCredentials): Promise<AuthResponse>;
    setSession(tokens: {
      access_token: string;
      refresh_token: string;
    }): Promise<AuthResponse>;
  };
  functions: {
    invoke(
      name: string,
      request?: { body?: Record<string, unknown> },
    ): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  };
}

export type AccountAuthBrowserResult =
  | { type: 'success'; url: string }
  | { type: 'cancel' }
  | { type: 'dismiss' };

export interface NativeAppleCredential {
  identityToken: string | null;
  authorizationCode: string | null;
  state: string | null;
}

export type AccountOAuthConsumeResult =
  | {
      status: 'main-linked';
      operationId: string;
      provider: BackupIdentityProvider;
      userId: string;
      email: string | null;
    }
  | {
      status: 'target-authenticated';
      operationId: string;
      provider: BackupIdentityProvider;
      userId: string;
      email: string | null;
      /** Returned to the initiating caller only; never written to the journal. */
      providerToken?: string;
    }
  | { status: 'identity-owned'; operationId: string; provider: BackupIdentityProvider }
  | { status: 'cancelled'; operationId: string; provider: BackupIdentityProvider };

export type ResumeAccountAuthResult =
  | { status: 'none' | 'pending' }
  | {
      status: 'repair-required';
      userId: string;
      provider: 'apple';
    }
  | {
      status: 'resumed';
      userId: string;
      provider: BackupIdentityProvider;
      email?: string | null;
    };

export interface SupabaseAccountAuthGateway extends AuthGateway {
  consumeOAuthCallback(
    url: string,
    consumer: 'opener' | 'route',
  ): Promise<AccountOAuthConsumeResult>;
  resumePendingOperation(): Promise<ResumeAccountAuthResult>;
  reauthenticate(
    provider: BackupIdentityProvider,
    expectedUserId: string,
    options?: { purpose?: 'account-access' | 'account-deletion' },
  ): Promise<
    | {
        status: 'reauthenticated';
        userId: string;
        accessToken: string;
        /** Google only and intentionally ephemeral. */
        providerToken?: string;
      }
    | { status: 'cancelled' }
  >;
}

export interface AccountAuthGatewayDependencies {
  mainClient: AccountAuthClient;
  createTransientClient(storageKey: string): AccountAuthClient;
  clearTransientStorage?(storageKey: string): Promise<void>;
  operationJournal?: OAuthOperationJournal;
  /** Web-only origin-wide lock held across PKCE recovery/exchange and durable save. */
  withOAuthCallbackLock?: OAuthOperationGlobalLock;
  platform: 'ios' | 'android' | 'web';
  redirectUri: string;
  openAuthSession(url: string, redirectUri: string): Promise<AccountAuthBrowserResult>;
  randomUUID(): string;
  sha256(value: string): Promise<string>;
  nativeApple: {
    isAvailable(): Promise<boolean>;
    signIn(input: {
      nonce: string;
      state: string;
      requestedScopes: readonly [];
    }): Promise<NativeAppleCredential>;
  };
}

export type AccountAuthErrorCode =
  | 'configuration'
  | 'offline'
  | 'invalid-callback'
  | 'invalid-provider-response'
  | 'apple-unavailable'
  | 'apple-token-storage'
  | 'callback-pending'
  | 'merge-unavailable'
  | 'operation-unavailable'
  | 'reauth-required';

export class AccountAuthError extends Error {
  readonly code: AccountAuthErrorCode;

  constructor(code: AccountAuthErrorCode, message: string) {
    super(message);
    this.name = 'AccountAuthError';
    this.code = code;
  }
}

/**
 * Converts authentication failures into copy that is safe to show in the UI.
 * Callback fields and provider/SDK messages may contain implementation details,
 * so invalid responses are deliberately replaced instead of echoed.
 */
export function accountAuthUserMessage(error: unknown): string {
  if (!(error instanceof AccountAuthError)) {
    return 'データ保存用アカウントに接続できませんでした。予定は端末に保存されています。';
  }

  switch (error.code) {
    case 'invalid-callback':
    case 'invalid-provider-response':
      return 'ログインを完了できませんでした。設定からもう一度お試しください。';
    case 'merge-unavailable':
      return 'アカウントのデータ統合を完了できませんでした。元のデータは保持されています。';
    case 'operation-unavailable':
      return 'ログインの有効期限が切れました。設定からもう一度お試しください。';
    case 'callback-pending':
      return 'ログイン処理を安全に再開しています。少し待って再試行してください。';
    case 'configuration':
      return 'データ保存用ログインの接続設定が未完了です。端末内の予定はそのまま使えます。';
    case 'offline':
      return 'データ保存用アカウントに接続できませんでした。予定は端末に保存されています。';
    case 'apple-unavailable':
      return 'Appleで保存はこの端末で利用できません。Googleで保存をお試しください。';
    case 'apple-token-storage':
      return 'Appleアカウントの削除用認証情報を安全に保存できませんでした。もう一度お試しください。';
    case 'reauth-required':
      return 'クラウド保存を続けるには、もう一度ログインが必要です。';
  }
}

export type AccountOAuthCallback =
  | { status: 'code'; code: string }
  | {
      status: 'error';
      error: string;
      errorCode?: string;
      description?: string;
    };

const CALLBACK_FIELDS = new Set(['code', 'error', 'error_code', 'error_description']);
const CONFIGURATION_CODES = new Set([
  'manual_linking_disabled',
  'oauth_provider_not_supported',
  'provider_disabled',
]);

function authErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isCancelledError(error: unknown) {
  const code = authErrorCode(error);
  return code === 'ERR_REQUEST_CANCELED' || code === 'ERR_CANCELED';
}

function toAuthError(error: AuthErrorLike | unknown, fallback: AccountAuthErrorCode) {
  if (error instanceof AccountAuthError) return error;
  const code = authErrorCode(error);
  if (code && CONFIGURATION_CODES.has(code)) {
    return new AccountAuthError(
      'configuration',
      'データ保存用ログインの公開設定が未完了です。端末内のデータはそのまま使えます。',
    );
  }
  if (code === 'session_expired' || code === 'refresh_token_not_found') {
    return new AccountAuthError(
      'reauth-required',
      'クラウド保存を続けるには、もう一度ログインが必要です。',
    );
  }
  return new AccountAuthError(
    fallback,
    'データ保存用アカウントに接続できませんでした。予定は端末に保存されています。',
  );
}

function parseSingleValue(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length > 1) {
    throw new AccountAuthError('invalid-callback', `Duplicate OAuth callback field: ${name}`);
  }
  return values[0] || undefined;
}

export function parseAccountOAuthCallback(url: string): AccountOAuthCallback {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AccountAuthError('invalid-callback', 'Invalid OAuth callback URL');
  }

  if (parsed.hash) {
    throw new AccountAuthError(
      'invalid-callback',
      'Implicit OAuth tokens are not accepted; PKCE code flow is required',
    );
  }
  for (const key of parsed.searchParams.keys()) {
    if (!CALLBACK_FIELDS.has(key)) {
      throw new AccountAuthError('invalid-callback', `Unexpected OAuth callback field: ${key}`);
    }
  }

  const code = parseSingleValue(parsed.searchParams, 'code');
  const error = parseSingleValue(parsed.searchParams, 'error');
  const errorCode = parseSingleValue(parsed.searchParams, 'error_code');
  const description = parseSingleValue(parsed.searchParams, 'error_description');

  if (code && !error && !errorCode && !description) return { status: 'code', code };
  if (!code && error) {
    return {
      status: 'error',
      error,
      ...(errorCode ? { errorCode } : {}),
      ...(description ? { description } : {}),
    };
  }
  throw new AccountAuthError('invalid-callback', 'Incomplete OAuth callback');
}

function isIdentityOwned(error: AuthErrorLike | null) {
  return error?.code === 'identity_already_exists';
}

function requireHostedUrl(response: HostedResponse) {
  if (response.error) throw toAuthError(response.error, 'offline');
  if (!response.data.url) {
    throw new AccountAuthError('invalid-provider-response', 'OAuth provider URL was missing');
  }
  return response.data.url;
}

function requireSession(response: AuthResponse): AccountAuthSession {
  if (response.error) throw toAuthError(response.error, 'offline');
  if (!response.data.session?.user?.id || !response.data.session.access_token || !response.data.session.refresh_token) {
    throw new AccountAuthError('invalid-provider-response', 'Provider session was incomplete');
  }
  return response.data.session;
}

function scopesValue(scopes: readonly string[]) {
  const value = scopes.filter(Boolean).join(' ');
  return value || undefined;
}

function hostedCredentials(
  provider: BackupIdentityProvider,
  scopes: readonly string[],
  redirectUri: string,
): HostedCredentials {
  return {
    provider,
    options: {
      redirectTo: redirectUri,
      ...(scopesValue(scopes) ? { scopes: scopesValue(scopes) } : {}),
      skipBrowserRedirect: true,
    },
  };
}

async function browserCallback(
  dependencies: AccountAuthGatewayDependencies,
  authorizeUrl: string,
): Promise<{ status: 'callback'; url: string } | { status: 'cancelled' }> {
  const result = await dependencies.openAuthSession(authorizeUrl, dependencies.redirectUri);
  if (result.type === 'cancel' || result.type === 'dismiss') return { status: 'cancelled' };
  return { status: 'callback', url: result.url };
}

async function getAppleCredential(
  dependencies: AccountAuthGatewayDependencies,
  journal: OAuthOperationJournal,
  operationId: string,
) {
  if (dependencies.platform !== 'ios' || !(await dependencies.nativeApple.isAvailable())) {
    throw new AccountAuthError(
      'apple-unavailable',
      'Appleで保存はこの端末で利用できません。Googleで保存をお試しください。',
    );
  }
  const rawNonce = dependencies.randomUUID();
  const state = dependencies.randomUUID();
  try {
    const expectedNonceHash = await dependencies.sha256(rawNonce);
    await journal.saveAppleNonce(operationId, expectedNonceHash);
    const credential = await dependencies.nativeApple.signIn({
      nonce: expectedNonceHash,
      state,
      requestedScopes: [],
    });
    if (credential.state !== state) {
      throw new AccountAuthError('invalid-provider-response', 'Apple OAuth state did not match');
    }
    if (!credential.identityToken) {
      throw new AccountAuthError('invalid-provider-response', 'Apple identity token was missing');
    }
    if (!credential.authorizationCode) {
      throw new AccountAuthError(
        'invalid-provider-response',
        'Apple authorization code was missing',
      );
    }
    return {
      identityToken: credential.identityToken,
      authorizationCode: credential.authorizationCode,
      expectedNonceHash,
      rawNonce,
    };
  } catch (error) {
    if (isCancelledError(error)) return null;
    throw error instanceof AccountAuthError
      ? error
      : toAuthError(error, 'offline');
  }
}

async function storeAppleAuthorizationCode(
  client: AccountAuthClient,
  authorizationCode: string,
  expectedNonceHash: string,
) {
  const response = await client.functions.invoke('store-apple-token', {
    body: { authorizationCode, expectedNonceHash },
  });
  if (response.error) {
    throw new AccountAuthError(
      'apple-token-storage',
      'Appleアカウントの削除用認証情報を安全に保存できませんでした。もう一度お試しください。',
    );
  }
}

function functionRecord(data: unknown, functionName: string) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AccountAuthError('merge-unavailable', `${functionName} returned an invalid response`);
  }
  return data as Record<string, unknown>;
}

const callbackOperations = new WeakMap<
  OAuthOperationJournal,
  Promise<AccountOAuthConsumeResult>
>();
const OAUTH_CALLBACK_PROCESSING_LOCK_NAME =
  'recoto.account.oauth-callback-processing.lock.v1';

function fallbackOperationJournal(): OAuthOperationJournal {
  let sequence = 0;
  return createOAuthOperationJournal({
    storage: createMemoryStorage(),
    randomUUID: () => `memory-operation-${++sequence}`,
  });
}

function validateCallbackDestination(url: string, expectedRedirectUri: string) {
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(url);
    expected = new URL(expectedRedirectUri);
  } catch {
    throw new AccountAuthError('invalid-callback', 'Invalid OAuth callback destination');
  }
  if (
    actual.protocol !== expected.protocol ||
    actual.hostname !== expected.hostname ||
    actual.port !== expected.port ||
    actual.pathname !== expected.pathname ||
    actual.username ||
    actual.password
  ) {
    throw new AccountAuthError('invalid-callback', 'OAuth callback destination did not match');
  }
}

/**
 * Validates an exact callback against the one active operation before writing
 * it to the durable inbox. The popup calls this before notifying its opener.
 */
export async function inboxAccountOAuthCallback(
  journal: OAuthOperationJournal,
  url: string,
): Promise<OAuthOperationRecord> {
  const operation = await journal.read();
  if (!operation) {
    throw new AccountAuthError(
      'operation-unavailable',
      'OAuth operation was missing or expired',
    );
  }
  validateCallbackDestination(url, operation.redirectUri);
  // The destination, active operation, strict field allowlist and PKCE verifier
  // form the callback state boundary. Never persist fragment tokens.
  parseAccountOAuthCallback(url);
  return journal.saveCallback(operation.operationId, url);
}

function transientSession(session: AccountAuthSession): ExistingProviderSession {
  return {
    status: 'authenticated',
    userId: session.user.id,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  };
}

export function createSupabaseAuthGateway(
  dependencies: AccountAuthGatewayDependencies,
): SupabaseAccountAuthGateway {
  const journal = dependencies.operationJournal ?? fallbackOperationJournal();
  let pendingTransient:
    | {
        operationId: string;
        storageKey: string;
        client: AccountAuthClient;
        session: ExistingProviderSession;
      }
    | null = null;

  async function requireActiveOperation() {
    const operation = await journal.read();
    if (!operation) {
      throw new AccountAuthError(
        'operation-unavailable',
        'OAuth operation was missing or expired',
      );
    }
    return operation;
  }

  function transientClient(operation: OAuthOperationRecord) {
    if (!operation.transientStorageKey) {
      throw new AccountAuthError(
        'operation-unavailable',
        'Transient OAuth storage was missing',
      );
    }
    return dependencies.createTransientClient(operation.transientStorageKey);
  }

  async function verifyMainSession(expectedUserId: string) {
    const stored = await dependencies.mainClient.auth.getSession();
    if (stored.error) throw toAuthError(stored.error, 'offline');
    if (stored.data.session?.user.id !== expectedUserId) {
      throw new AccountAuthError(
        'invalid-provider-response',
        'Persisted account session did not match expected UID',
      );
    }
    const verified = await dependencies.mainClient.auth.getUser();
    if (verified.error) throw toAuthError(verified.error, 'offline');
    if (verified.data.user?.id !== expectedUserId) {
      throw new AccountAuthError(
        'invalid-provider-response',
        'Verified account session did not match expected UID',
      );
    }
    return verified.data.user;
  }

  async function recoverPersistedProviderSession(
    client: AccountAuthClient,
    operation: OAuthOperationRecord,
  ): Promise<AccountAuthSession | null> {
    const stored = await client.auth.getSession();
    if (stored.error) throw toAuthError(stored.error, 'offline');
    const session = stored.data.session;
    if (!session?.user?.id || !session.access_token || !session.refresh_token) return null;

    const verified = await client.auth.getUser();
    if (verified.error) throw toAuthError(verified.error, 'offline');
    const user = verified.data.user;
    if (!user?.id || user.id !== session.user.id) return null;
    if (!user.identities?.some((identity) => identity.provider === operation.provider)) return null;

    if (
      (operation.kind === 'main-link' || operation.kind === 'reauth')
      && user.id !== operation.expectedUserId
    ) return null;
    if (operation.kind === 'transient-merge' && user.id === operation.expectedUserId) return null;

    return { ...session, user };
  }

  async function recoverPendingNativeApple(
    operation: OAuthOperationRecord,
  ): Promise<OAuthOperationRecord | { repairUserId: string } | { abandoned: true } | null> {
    if (
      dependencies.platform !== 'ios'
      || operation.provider !== 'apple'
      || operation.stage !== 'awaiting-provider'
      || !operation.apple?.expectedNonceHash
    ) return null;

    const client = operation.kind === 'main-link'
      ? dependencies.mainClient
      : transientClient(operation);
    const stored = await recoverPersistedProviderSession(client, operation);
    if (!stored) return { abandoned: true };

    const status = await client.functions.invoke('apple-credential-status');
    if (status.error) throw toAuthError(status.error, 'offline');
    const value = status.data as Record<string, unknown> | null;
    if (
      !value
      || value.hasIdentity !== true
      || typeof value.hasCredential !== 'boolean'
    ) {
      throw new AccountAuthError(
        'invalid-provider-response',
        'Apple credential status was invalid',
      );
    }

    const target = transientSession(stored);
    if (!value.hasCredential) {
      await journal.markAppleCredentialRepair(operation.operationId, {
        expectedUserId: target.userId,
        expectedNonceHash: operation.apple.expectedNonceHash,
        targetSession: target,
      });
      return { repairUserId: target.userId };
    }
    await journal.saveTargetSession(operation.operationId, target);
    return requireActiveOperation();
  }

  async function recoverCommittedAppleCredential(
    operation: OAuthOperationRecord,
  ): Promise<
    | { status: 'recovered'; operation: OAuthOperationRecord }
    | { status: 'repair-required'; userId: string }
    | null
  > {
    if (
      operation.kind !== 'apple-credential-repair'
      || operation.stage !== 'credential-repair-required'
      || operation.provider !== 'apple'
    ) return null;
    if (!operation.targetSession || operation.targetSession.userId !== operation.expectedUserId) {
      throw new AccountAuthError(
        'operation-unavailable',
        'Apple credential repair session was missing',
      );
    }

    // Always restore the journaled target into an isolated client. For a
    // reauthentication repair this is the fresh OAuth proof required by the
    // destructive endpoint; falling back to the older main session would lose
    // its recent AMR even though credential storage already committed.
    const client = transientClient(operation);
    const restored = requireSession(await client.auth.setSession({
      access_token: operation.targetSession.accessToken,
      refresh_token: operation.targetSession.refreshToken,
    }));
    if (restored.user.id !== operation.expectedUserId) {
      throw new AccountAuthError(
        'invalid-provider-response',
        'Apple credential repair session did not match expected UID',
      );
    }
    const stored = await recoverPersistedProviderSession(client, operation);
    if (!stored || stored.user.id !== operation.expectedUserId) {
      throw new AccountAuthError(
        'reauth-required',
        'Apple credential repair session could not be verified',
      );
    }

    // This Edge endpoint derives both UID and Apple subject from the verified
    // access token. A transport error after DB commit therefore becomes a
    // successful resume without consuming a second Apple authorization code.
    const status = await client.functions.invoke('apple-credential-status');
    if (status.error) throw toAuthError(status.error, 'offline');
    const value = status.data as Record<string, unknown> | null;
    if (
      !value
      || value.hasIdentity !== true
      || typeof value.hasCredential !== 'boolean'
    ) {
      throw new AccountAuthError(
        'invalid-provider-response',
        'Apple credential status was invalid',
      );
    }
    if (!value.hasCredential) {
      return { status: 'repair-required', userId: operation.expectedUserId };
    }
    return {
      status: 'recovered',
      operation: await journal.completeAppleCredentialRepair(
        operation.operationId,
        transientSession(stored),
      ),
    };
  }

  async function activateJournaledSession(operation: OAuthOperationRecord) {
    const target = operation.targetSession;
    if (!target) {
      throw new AccountAuthError('operation-unavailable', 'Target account session was missing');
    }
    const activated = requireSession(
      await dependencies.mainClient.auth.setSession({
        access_token: target.accessToken,
        refresh_token: target.refreshToken,
      }),
    );
    if (activated.user.id !== target.userId) {
      throw new AccountAuthError('invalid-provider-response', 'Activated account did not match');
    }
    const user = await verifyMainSession(target.userId);
    // The persistent auth adapter verifies its own write. Keep the recovery
    // journal until both the persisted session and the server-verified UID read
    // back correctly.
    await journal.clearAfterVerifiedSession(operation.operationId, target.userId);
    pendingTransient = null;
    if (operation.transientStorageKey) {
      await dependencies.clearTransientStorage?.(operation.transientStorageKey).catch(() => undefined);
    }
    return user;
  }

  const consumeOAuthCallback = async (
    url: string,
    consumer: 'opener' | 'route',
  ): Promise<AccountOAuthConsumeResult> => {
    const cached = callbackOperations.get(journal);
    if (cached) return cached;

    const complete = async (): Promise<AccountOAuthConsumeResult> => {
      const inboxedOperation = await inboxAccountOAuthCallback(journal, url);
      const claim = await journal.claimCallback(inboxedOperation.operationId, consumer);
      const claimedOperation = claim.operation;
      const callback = parseAccountOAuthCallback(claimedOperation.callback?.url ?? url);
      const isMainLink = claimedOperation.kind === 'main-link';
      const client = isMainLink
        ? dependencies.mainClient
        : transientClient(claimedOperation);
      const recovered = await recoverPersistedProviderSession(client, claimedOperation);
      if (claim.status !== 'claimed' && !recovered) {
        throw new AccountAuthError(
          'callback-pending',
          'OAuth callback is being completed in another app instance',
        );
      }
      if (callback.status === 'error') {
        if (callback.errorCode === 'identity_already_exists') {
          if (claimedOperation.kind !== 'main-link') {
            throw new AccountAuthError(
              'invalid-provider-response',
              'Transient sign-in returned an identity-linking conflict',
            );
          }
          await journal.markIdentityOwned(claimedOperation.operationId);
          return {
            status: 'identity-owned',
            operationId: claimedOperation.operationId,
            provider: claimedOperation.provider,
          };
        }
        if (callback.error === 'access_denied') {
          if (claimedOperation.intent) {
            await dependencies.mainClient.functions.invoke('cancel-account-merge', {
              body: { intentId: claimedOperation.intent.intentId },
            }).catch(() => undefined);
          }
          await journal.cancel(claimedOperation.operationId);
          return {
            status: 'cancelled',
            operationId: claimedOperation.operationId,
            provider: claimedOperation.provider,
          };
        }
        throw toAuthError(
          { code: callback.errorCode, message: callback.description ?? callback.error },
          'offline',
        );
      }

      const response = recovered
        ? { data: { user: recovered.user, session: recovered }, error: null }
        : await client.auth.exchangeCodeForSession(callback.code);
      if (isIdentityOwned(response.error)) {
        if (!isMainLink) {
          throw new AccountAuthError(
            'invalid-provider-response',
            'Transient sign-in returned an identity-linking conflict',
          );
        }
        await journal.markIdentityOwned(claimedOperation.operationId);
        return {
          status: 'identity-owned',
          operationId: claimedOperation.operationId,
          provider: claimedOperation.provider,
        };
      }
      const session = requireSession(response);

      if (isMainLink) {
        if (session.user.id !== claimedOperation.expectedUserId) {
          throw new AccountAuthError(
            'invalid-provider-response',
            'Linking the identity changed the active UID',
          );
        }
        await journal.saveTargetSession(
          claimedOperation.operationId,
          transientSession(session),
        );
        const user = await verifyMainSession(claimedOperation.expectedUserId);
        await journal.clearAfterVerifiedSession(
          claimedOperation.operationId,
          claimedOperation.expectedUserId,
        );
        return {
          status: 'main-linked',
          operationId: claimedOperation.operationId,
          provider: claimedOperation.provider,
          userId: user.id,
          email: user.email ?? session.user.email ?? null,
        };
      }

      const target = transientSession(session);
      await journal.saveTargetSession(claimedOperation.operationId, target);
      pendingTransient = {
        operationId: claimedOperation.operationId,
        storageKey: claimedOperation.transientStorageKey!,
        client,
        session: target,
      };
      return {
        status: 'target-authenticated',
        operationId: claimedOperation.operationId,
        provider: claimedOperation.provider,
        userId: target.userId,
        email: session.user.email ?? null,
        ...(session.provider_token ? { providerToken: session.provider_token } : {}),
      };
    };
    const promise = dependencies.platform === 'web'
      ? dependencies.withOAuthCallbackLock
        ? dependencies.withOAuthCallbackLock(OAUTH_CALLBACK_PROCESSING_LOCK_NAME, complete)
        : Promise.reject(new AccountAuthError(
            'configuration',
            'Secure cross-tab OAuth callback locking is unavailable',
          ))
      : complete();
    callbackOperations.set(journal, promise);
    void promise.finally(() => {
      if (callbackOperations.get(journal) === promise) {
        callbackOperations.delete(journal);
      }
    }).catch(() => undefined);
    return promise;
  };

  const authenticateHosted = async (
    client: AccountAuthClient,
    provider: BackupIdentityProvider,
    scopes: readonly string[],
    mode: 'link' | 'sign-in',
    operation: OAuthOperationRecord,
  ): Promise<AccountOAuthConsumeResult> => {
    const response = mode === 'link'
      ? await client.auth.linkIdentity(hostedCredentials(provider, scopes, dependencies.redirectUri))
      : await client.auth.signInWithOAuth(hostedCredentials(provider, scopes, dependencies.redirectUri));
    if (isIdentityOwned(response.error)) {
      await journal.markIdentityOwned(operation.operationId);
      return {
        status: 'identity-owned',
        operationId: operation.operationId,
        provider,
      };
    }
    const authorizeUrl = requireHostedUrl(response as HostedResponse);
    await journal.markAwaitingCallback(operation.operationId);
    const callback = await browserCallback(dependencies, authorizeUrl);
    if (callback.status === 'cancelled') {
      return { status: 'cancelled', operationId: operation.operationId, provider };
    }
    return consumeOAuthCallback(callback.url, 'opener');
  };

  const gateway: SupabaseAccountAuthGateway = {
    async getCurrentIdentity() {
      const response = await dependencies.mainClient.auth.getUser();
      if (response.error) throw toAuthError(response.error, 'offline');
      return response.data.user
        ? {
            userId: response.data.user.id,
            isAnonymous: response.data.user.is_anonymous === true,
          }
        : null;
    },

    async linkIdentity(provider, scopes): Promise<LinkIdentityResult> {
      callbackOperations.delete(journal);
      const current = await dependencies.mainClient.auth.getUser();
      if (current.error) throw toAuthError(current.error, 'offline');
      if (!current.data.user?.id) {
        throw new AccountAuthError('reauth-required', 'A verified source session is required');
      }
      const existing = await journal.read();
      if (
        existing?.kind === 'main-link'
        && existing.stage === 'identity-owned'
        && existing.provider === provider
        && existing.expectedUserId === current.data.user.id
      ) {
        return { status: 'identity-owned' };
      }
      if (existing) {
        throw new AccountAuthError('operation-unavailable', 'Another OAuth operation is active');
      }
      const operation = await journal.begin({
        kind: 'main-link',
        provider,
        expectedUserId: current.data.user.id,
        redirectUri: dependencies.redirectUri,
      });

      if (provider === 'apple' && dependencies.platform === 'ios') {
        const apple = await getAppleCredential(dependencies, journal, operation.operationId);
        if (!apple) {
          await journal.cancel(operation.operationId);
          return { status: 'cancelled' };
        }
        const response = await dependencies.mainClient.auth.linkIdentity({
          provider: 'apple',
          token: apple.identityToken,
          nonce: apple.rawNonce,
        });
        if (isIdentityOwned(response.error)) {
          await journal.markIdentityOwned(operation.operationId);
          return { status: 'identity-owned' };
        }
        const session = requireSession(response as AuthResponse);
        if (session.user.id !== operation.expectedUserId) {
          throw new AccountAuthError(
            'invalid-provider-response',
            'Linking Apple changed the active UID',
          );
        }
        try {
          await storeAppleAuthorizationCode(
            dependencies.mainClient,
            apple.authorizationCode,
            apple.expectedNonceHash,
          );
        } catch (error) {
          await journal.markAppleCredentialRepair(operation.operationId, {
            expectedUserId: session.user.id,
            expectedNonceHash: apple.expectedNonceHash,
            targetSession: transientSession(session),
          });
          throw error;
        }
        await verifyMainSession(operation.expectedUserId);
        // Native linking has no PKCE callback, so save the returned session as
        // the verification marker before using the same checked clear path.
        await journal.saveTargetSession(operation.operationId, transientSession(session));
        await journal.clearAfterVerifiedSession(operation.operationId, operation.expectedUserId);
        return { status: 'linked', userId: session.user.id };
      }

      const result = await authenticateHosted(
        dependencies.mainClient,
        provider,
        scopes,
        'link',
        operation,
      );
      if (result.status === 'cancelled') {
        await journal.cancel(operation.operationId);
        return { status: 'cancelled' };
      }
      if (result.status === 'identity-owned') return { status: 'identity-owned' };
      if (result.status !== 'main-linked') {
        throw new AccountAuthError('invalid-provider-response', 'Main link used a transient session');
      }
      return { status: 'linked', userId: result.userId };
    },

    async startMerge(sourceUserId): Promise<MergeIntent> {
      // A provider-owned response starts a second isolated OAuth round. Do not
      // let its callback share the completed main-link consumer promise.
      callbackOperations.delete(journal);
      const operation = await requireActiveOperation();
      if (operation.kind !== 'main-link' || operation.expectedUserId !== sourceUserId) {
        throw new AccountAuthError('merge-unavailable', 'Merge source operation did not match');
      }
      const response = await dependencies.mainClient.functions.invoke('start-account-merge', {
        body: { sourceUserId },
      });
      if (response.error) throw toAuthError(response.error, 'merge-unavailable');
      const data = functionRecord(response.data, 'start-account-merge');
      if (typeof data.intentId !== 'string' || typeof data.nonce !== 'string') {
        throw new AccountAuthError('merge-unavailable', 'Merge intent was incomplete');
      }
      const intent = { intentId: data.intentId, nonce: data.nonce };
      await journal.setMergeIntent(
        operation.operationId,
        sourceUserId,
        intent,
        `recoto-transient-${operation.operationId}`,
      );
      return intent;
    },

    async authenticateExistingIdentity(provider, scopes, intent) {
      let operation = await journal.read();
      if (!operation) {
        callbackOperations.delete(journal);
        const source = await dependencies.mainClient.auth.getUser();
        if (source.error) throw toAuthError(source.error, 'offline');
        if (!source.data.user?.id) {
          throw new AccountAuthError('merge-unavailable', 'Merge source session was missing');
        }
        operation = await journal.begin({
          kind: 'transient-merge',
          provider,
          expectedUserId: source.data.user.id,
          redirectUri: dependencies.redirectUri,
          intent,
        });
      }
      if (
        operation.kind !== 'transient-merge' ||
        operation.provider !== provider ||
        operation.intent?.intentId !== intent.intentId ||
        operation.intent.nonce !== intent.nonce
      ) {
        throw new AccountAuthError('merge-unavailable', 'Merge operation did not match');
      }
      const transient = transientClient(operation);
      let result: ExistingProviderSession;

      if (provider === 'apple' && dependencies.platform === 'ios') {
        const apple = await getAppleCredential(dependencies, journal, operation.operationId);
        if (!apple) return { status: 'cancelled' };
        const session = requireSession(
          await transient.auth.signInWithIdToken({
            provider: 'apple',
            token: apple.identityToken,
            nonce: apple.rawNonce,
          }),
        );
        try {
          // Apple authorization codes are one-time values: send immediately and
          // never put them in the client journal.
          await storeAppleAuthorizationCode(
            transient,
            apple.authorizationCode,
            apple.expectedNonceHash,
          );
        } catch (error) {
          await journal.markAppleCredentialRepair(operation.operationId, {
            expectedUserId: session.user.id,
            expectedNonceHash: apple.expectedNonceHash,
            targetSession: transientSession(session),
          });
          throw error;
        }
        result = transientSession(session);
        await journal.saveTargetSession(operation.operationId, result);
      } else {
        const hosted = await authenticateHosted(transient, provider, scopes, 'sign-in', operation);
        if (hosted.status === 'cancelled') return { status: 'cancelled' };
        if (hosted.status === 'identity-owned' || hosted.status === 'main-linked') {
          throw new AccountAuthError(
            'invalid-provider-response',
            'Existing account sign-in unexpectedly returned an identity-linking conflict',
          );
        }
        const stored = await requireActiveOperation();
        if (!stored.targetSession || stored.targetSession.userId !== hosted.userId) {
          throw new AccountAuthError('operation-unavailable', 'Target session was not journaled');
        }
        result = stored.targetSession;
      }

      pendingTransient = {
        operationId: operation.operationId,
        storageKey: operation.transientStorageKey!,
        client: transient,
        session: result,
      };
      return result;
    },

    async completeMerge(input) {
      const operation = await journal.read();
      if (!operation) {
        const current = await dependencies.mainClient.auth.getUser();
        if (!current.error && current.data.user?.id === input.targetUserId) {
          return { userId: input.targetUserId };
        }
        throw new AccountAuthError('merge-unavailable', 'Merge recovery record was missing');
      }
      if (
        operation.kind !== 'transient-merge' ||
        operation.intent?.intentId !== input.intentId ||
        operation.intent.nonce !== input.nonce ||
        operation.expectedUserId !== input.sourceUserId ||
        operation.targetSession?.userId !== input.targetUserId ||
        operation.targetSession.accessToken !== input.targetAccessToken
      ) {
        throw new AccountAuthError(
          'merge-unavailable',
          'Verified transient merge session was missing',
        );
      }
      if (operation.stage === 'merge-completed') return { userId: input.targetUserId };
      const client =
        pendingTransient?.operationId === operation.operationId
          ? pendingTransient.client
          : transientClient(operation);
      const transientVerified = requireSession(
        await client.auth.setSession({
          access_token: operation.targetSession.accessToken,
          refresh_token: operation.targetSession.refreshToken,
        }),
      );
      if (transientVerified.user.id !== input.targetUserId) {
        throw new AccountAuthError('merge-unavailable', 'Transient merge UID did not match');
      }
      const response = await client.functions.invoke('complete-account-merge', {
        body: {
          intentId: input.intentId,
          nonce: input.nonce,
          sourceUserId: input.sourceUserId,
        },
      });
      if (response.error) throw toAuthError(response.error, 'merge-unavailable');
      const data = functionRecord(response.data, 'complete-account-merge');
      if (typeof data.userId !== 'string' || data.userId !== input.targetUserId) {
        throw new AccountAuthError('merge-unavailable', 'Merge target did not match');
      }
      await journal.markMergeCompleted(operation.operationId, data.userId);
      return { userId: data.userId };
    },

    async activateSession(session) {
      const operation = await journal.read();
      if (!operation) {
        const current = await dependencies.mainClient.auth.getUser();
        if (!current.error && current.data.user?.id === session.userId) return;
        throw new AccountAuthError('merge-unavailable', 'Merge session was no longer available');
      }
      if (
        operation.kind !== 'transient-merge' ||
        operation.stage !== 'merge-completed' ||
        operation.targetSession?.userId !== session.userId
      ) {
        throw new AccountAuthError('merge-unavailable', 'Merge session was not ready to activate');
      }
      await activateJournaledSession(operation);
    },

    async cancelMerge(intentId) {
      pendingTransient = null;
      // Best effort: cancellation must never turn a provider dismissal into an error.
      await dependencies.mainClient.functions
        .invoke('cancel-account-merge', { body: { intentId } })
        .catch(() => undefined);
      const operation = await journal.read();
      if (operation?.intent?.intentId === intentId) {
        await journal.cancel(operation.operationId);
      }
    },

    consumeOAuthCallback,

    async resumePendingOperation(): Promise<ResumeAccountAuthResult> {
      let operation = await journal.read();
      if (!operation) return { status: 'none' };
      const recoveredApple = await recoverPendingNativeApple(operation);
      if (recoveredApple && 'abandoned' in recoveredApple) {
        await journal.cancel(operation.operationId);
        return { status: 'none' };
      }
      if (recoveredApple && 'repairUserId' in recoveredApple) {
        return {
          status: 'repair-required',
          userId: recoveredApple.repairUserId,
          provider: 'apple',
        };
      }
      if (recoveredApple) operation = recoveredApple;
      const recoveredCredential = await recoverCommittedAppleCredential(operation);
      if (recoveredCredential?.status === 'repair-required') {
        return {
          status: 'repair-required',
          userId: recoveredCredential.userId,
          provider: 'apple',
        };
      }
      if (recoveredCredential?.status === 'recovered') {
        operation = recoveredCredential.operation;
      }
      if (
        operation.callback
        && (operation.stage === 'awaiting-callback' || operation.stage === 'callback-claimed')
      ) {
        let callbackResult: AccountOAuthConsumeResult;
        try {
          callbackResult = await consumeOAuthCallback(operation.callback.url, 'route');
        } catch (error) {
          if (error instanceof AccountAuthError && error.code === 'callback-pending') {
            return { status: 'pending' };
          }
          throw error;
        }
        if (callbackResult.status === 'cancelled') return { status: 'none' };
        if (callbackResult.status === 'main-linked') {
          return {
            status: 'resumed',
            userId: callbackResult.userId,
            provider: callbackResult.provider,
            email: callbackResult.email,
          };
        }
        if (callbackResult.status === 'identity-owned') return { status: 'pending' };
        operation = await journal.read();
        if (!operation) return { status: 'none' };
      }
      if (
        operation.stage === 'credential-repair-required'
      ) {
        return {
          status: 'repair-required',
          userId: operation.expectedUserId,
          provider: 'apple',
        };
      }
      if (
        operation.kind === 'main-link' &&
        operation.stage === 'target-authenticated' &&
        operation.targetSession?.userId === operation.expectedUserId
      ) {
        const user = await activateJournaledSession(operation);
        return {
          status: 'resumed',
          userId: user.id,
          provider: operation.provider,
          email: user.email ?? null,
        };
      }
      if (
        operation.kind === 'transient-merge' &&
        operation.targetSession &&
        (operation.stage === 'target-authenticated' || operation.stage === 'merge-completed')
      ) {
        if (operation.stage === 'target-authenticated') {
          await gateway.completeMerge({
            intentId: operation.intent!.intentId,
            nonce: operation.intent!.nonce,
            sourceUserId: operation.expectedUserId,
            targetUserId: operation.targetSession.userId,
            targetAccessToken: operation.targetSession.accessToken,
          });
          operation = await requireActiveOperation();
        }
        const user = await activateJournaledSession(operation);
        return {
          status: 'resumed',
          userId: user.id,
          provider: operation.provider,
          email: user.email ?? null,
        };
      }
      if (
        (operation.kind === 'reauth' || operation.kind === 'apple-credential-repair') &&
        operation.stage === 'target-authenticated' &&
        operation.targetSession
      ) {
        const user = await activateJournaledSession(operation);
        return {
          status: 'resumed',
          userId: user.id,
          provider: operation.provider,
          email: user.email ?? null,
        };
      }
      return { status: 'pending' };
    },

    async reauthenticate(provider, expectedUserId, options = {}) {
      callbackOperations.delete(journal);
      const existing = await journal.read();
      const repairingAppleCredential =
        existing?.kind === 'apple-credential-repair' &&
        provider === 'apple' &&
        existing.expectedUserId === expectedUserId;
      if (existing && !repairingAppleCredential) {
        throw new AccountAuthError('operation-unavailable', 'Another OAuth operation is active');
      }
      if (repairingAppleCredential) {
        const recovered = await recoverCommittedAppleCredential(existing);
        if (recovered?.status === 'recovered') {
          let stored = recovered.operation;
          const target = stored.targetSession;
          if (!target) {
            throw new AccountAuthError(
              'operation-unavailable',
              'Recovered Apple session was missing',
            );
          }
          if (
            stored.kind === 'transient-merge'
            && stored.stage === 'target-authenticated'
            && stored.intent
          ) {
            await gateway.completeMerge({
              intentId: stored.intent.intentId,
              nonce: stored.intent.nonce,
              sourceUserId: stored.expectedUserId,
              targetUserId: target.userId,
              targetAccessToken: target.accessToken,
            });
            stored = await requireActiveOperation();
          }
          await activateJournaledSession(stored);
          return {
            status: 'reauthenticated',
            userId: target.userId,
            accessToken: target.accessToken,
          };
        }
      }
      let operation = existing ?? await journal.begin({
          kind: 'reauth',
          provider,
          expectedUserId,
          redirectUri: dependencies.redirectUri,
        });
      const transient = transientClient(operation);
      let target: ExistingProviderSession;
      let providerToken: string | undefined;

      if (provider === 'apple' && dependencies.platform === 'ios') {
        const apple = await getAppleCredential(dependencies, journal, operation.operationId);
        if (!apple) {
          if (!repairingAppleCredential) await journal.cancel(operation.operationId);
          return { status: 'cancelled' };
        }
        const session = requireSession(
          await transient.auth.signInWithIdToken({
            provider: 'apple',
            token: apple.identityToken,
            nonce: apple.rawNonce,
          }),
        );
        target = transientSession(session);
        if (target.userId !== expectedUserId) {
          if (!repairingAppleCredential) {
            await journal.cancel(operation.operationId).catch(() => undefined);
          }
          throw new AccountAuthError(
            'invalid-provider-response',
            'Reauthenticated Apple UID did not match expected UID',
          );
        }
        try {
          await storeAppleAuthorizationCode(
            transient,
            apple.authorizationCode,
            apple.expectedNonceHash,
          );
        } catch (error) {
          if (options.purpose !== 'account-deletion') {
            await journal.markAppleCredentialRepair(operation.operationId, {
              expectedUserId,
              expectedNonceHash: apple.expectedNonceHash,
              targetSession: target,
            });
            throw error;
          }
          // A fresh, same-UID Apple/Supabase proof is sufficient to authorize
          // deletion even if the provider-revocation credential cannot be
          // stored. The delete endpoint will persist its manual-revocation flag
          // and must never hold the user's Recoto data hostage to this failure.
        }
        if (repairingAppleCredential) {
          operation = await journal.completeAppleCredentialRepair(
            operation.operationId,
            target,
          );
        } else {
          await journal.saveTargetSession(operation.operationId, target);
        }
      } else {
        if (repairingAppleCredential) {
          throw new AccountAuthError(
            'apple-unavailable',
            'Apple credential repair requires native Sign in with Apple',
          );
        }
        const hosted = await authenticateHosted(
          transient,
          provider,
          provider === 'google' ? ['openid', 'email'] : [],
          'sign-in',
          operation,
        );
        if (hosted.status === 'cancelled') {
          await journal.cancel(operation.operationId);
          return { status: 'cancelled' };
        }
        if (hosted.status !== 'target-authenticated') {
          throw new AccountAuthError('invalid-provider-response', 'Reauthentication did not sign in');
        }
        const stored = await requireActiveOperation();
        if (!stored.targetSession) {
          throw new AccountAuthError('operation-unavailable', 'Reauthentication session was missing');
        }
        target = stored.targetSession;
        providerToken = hosted.providerToken;
      }
      if (target.userId !== expectedUserId) {
        await journal.cancel(operation.operationId).catch(() => undefined);
        throw new AccountAuthError(
          'invalid-provider-response',
          'Reauthenticated account did not match expected UID',
        );
      }
      let stored = await requireActiveOperation();
      pendingTransient = {
        operationId: operation.operationId,
        storageKey: operation.transientStorageKey!,
        client: transient,
        session: target,
      };
      if (
        stored.kind === 'transient-merge' &&
        stored.stage === 'target-authenticated' &&
        stored.intent &&
        stored.targetSession
      ) {
        await gateway.completeMerge({
          intentId: stored.intent.intentId,
          nonce: stored.intent.nonce,
          sourceUserId: stored.expectedUserId,
          targetUserId: stored.targetSession.userId,
          targetAccessToken: stored.targetSession.accessToken,
        });
        stored = await requireActiveOperation();
      }
      await activateJournaledSession(stored);
      return {
        status: 'reauthenticated',
        userId: target.userId,
        accessToken: target.accessToken,
        ...(provider === 'google' && providerToken ? { providerToken } : {}),
      };
    },
  };
  return gateway;
}

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
}

function createTransientRecoveryStorage(storage: SupabaseAuthStorage): SupabaseAuthStorage {
  return createProviderTokenStrippingStorage(storage);
}

/**
 * A session-isolated PKCE client used only while proving ownership of an
 * already-connected provider account. When verified storage is supplied, its
 * PKCE verifier/session survive a process restart under a unique storage key;
 * they never replace the main client session.
 */
export function createTransientSupabaseAuthClient(
  url: string,
  anonKey: string,
  storageKey: string,
  storage?: SupabaseAuthStorage,
): AccountAuthClient {
  return createClient(url, anonKey, {
    auth: {
      flowType: 'pkce',
      storage: storage ? createTransientRecoveryStorage(storage) : createMemoryStorage(),
      storageKey,
      persistSession: Boolean(storage),
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }) as unknown as AccountAuthClient;
}
