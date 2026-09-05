export type BackupIdentityProvider = 'google' | 'apple';

export type LinkIdentityResult =
  | { status: 'linked'; userId: string }
  | { status: 'cancelled' }
  | { status: 'identity-owned' };

export interface ExistingProviderSession {
  status: 'authenticated';
  userId: string;
  accessToken: string;
  refreshToken: string;
}

export interface MergeIntent {
  intentId: string;
  nonce: string;
}

export interface AuthGateway {
  getCurrentIdentity(): Promise<{ userId: string; isAnonymous: boolean } | null>;
  linkIdentity(
    provider: BackupIdentityProvider,
    scopes: readonly string[],
  ): Promise<LinkIdentityResult>;
  startMerge(sourceUserId: string): Promise<MergeIntent>;
  /** Uses an isolated session and must not replace the app's active session. */
  authenticateExistingIdentity(
    provider: BackupIdentityProvider,
    scopes: readonly string[],
    intent: MergeIntent,
  ): Promise<ExistingProviderSession | { status: 'cancelled' }>;
  completeMerge(input: {
    intentId: string;
    nonce: string;
    sourceUserId: string;
    targetUserId: string;
    targetAccessToken: string;
  }): Promise<{ userId: string }>;
  activateSession(session: ExistingProviderSession): Promise<void>;
  cancelMerge(intentId: string): Promise<void>;
}

export type ConnectBackupIdentityResult =
  | { status: 'connected'; userId: string }
  | { status: 'merged'; userId: string }
  | { status: 'cancelled' };

const GOOGLE_ACCOUNT_SCOPES = Object.freeze(['openid', 'email'] as const);
const APPLE_ACCOUNT_SCOPES = Object.freeze([] as const);

function scopesFor(provider: BackupIdentityProvider): readonly string[] {
  return provider === 'google' ? GOOGLE_ACCOUNT_SCOPES : APPLE_ACCOUNT_SCOPES;
}

export async function connectBackupIdentity({
  provider,
  gateway,
}: {
  provider: BackupIdentityProvider;
  gateway: AuthGateway;
}): Promise<ConnectBackupIdentityResult> {
  const source = await gateway.getCurrentIdentity();
  if (!source?.userId) {
    throw new Error('A verified guest or account session is required before connecting backup');
  }

  const scopes = scopesFor(provider);
  const linkResult = await gateway.linkIdentity(provider, scopes);
  if (linkResult.status === 'cancelled') return { status: 'cancelled' };
  if (linkResult.status === 'linked') {
    if (linkResult.userId !== source.userId) {
      throw new Error('Linking the identity changed the active user unexpectedly');
    }
    return { status: 'connected', userId: source.userId };
  }

  const intent = await gateway.startMerge(source.userId);
  let targetSession: ExistingProviderSession | { status: 'cancelled' };
  try {
    targetSession = await gateway.authenticateExistingIdentity(provider, scopes, intent);
  } catch (error) {
    await gateway.cancelMerge(intent.intentId).catch(() => undefined);
    throw error;
  }
  if (targetSession.status === 'cancelled') {
    await gateway.cancelMerge(intent.intentId);
    return { status: 'cancelled' };
  }
  if (!targetSession.userId || targetSession.userId === source.userId) {
    throw new Error('Existing identity did not return a distinct target account');
  }

  const merged = await gateway.completeMerge({
    intentId: intent.intentId,
    nonce: intent.nonce,
    sourceUserId: source.userId,
    targetUserId: targetSession.userId,
    targetAccessToken: targetSession.accessToken,
  });
  if (merged.userId !== targetSession.userId) {
    throw new Error('The completed merge did not match the authenticated target account');
  }

  // Activation is intentionally last: account-scoped local caches must not switch
  // until the server has verified and completed the merge.
  await gateway.activateSession(targetSession);
  return { status: 'merged', userId: targetSession.userId };
}
