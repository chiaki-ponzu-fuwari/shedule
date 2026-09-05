import type { AccountBootstrapIdentity } from './accountBootstrap';
import type { BackupIdentityProvider } from './connectBackupIdentity';

export interface AppleCredentialVerifiedUser {
  id: string;
  email?: string | null;
  is_anonymous?: boolean;
  app_metadata?: Record<string, unknown>;
  identities?: Array<{
    id?: string | null;
    provider?: string | null;
    identity_data?: Record<string, unknown> | null;
  }> | null;
}

export interface AppleCredentialLifecycleAppState {
  currentState: string;
  addEventListener(
    event: 'change',
    listener: (state: string) => void,
  ): { remove(): void };
}

type AppleCredentialPlatform = 'ios' | 'android' | 'web';

function supportedProvider(user: AppleCredentialVerifiedUser): BackupIdentityProvider | null {
  const configuredProviders = Array.isArray(user.app_metadata?.providers)
    ? user.app_metadata.providers
    : [];
  const candidates = [
    user.app_metadata?.provider,
    ...configuredProviders,
    ...(user.identities ?? []).map((identity) => identity.provider),
  ];
  for (const candidate of candidates) {
    if (candidate === 'google' || candidate === 'apple') return candidate;
  }
  return null;
}

function baseIdentity(user: AppleCredentialVerifiedUser): AccountBootstrapIdentity {
  if (!user.id.trim()) throw new Error('A verified user id is required');
  if (user.is_anonymous) return { kind: 'anonymous', userId: user.id };
  const provider = supportedProvider(user);
  if (!provider) throw new Error('The verified account has no supported provider');
  return {
    kind: 'account',
    userId: user.id,
    provider,
    email: typeof user.email === 'string' && user.email.trim() ? user.email : null,
  };
}

function reauthenticationIdentity(
  identity: Extract<AccountBootstrapIdentity, { kind: 'account' }>,
): AccountBootstrapIdentity {
  return { ...identity, kind: 'reauth-required-account' };
}

export interface RevokedAppleAccountIdentity {
  kind: 'revoked-apple-account';
  userId: string;
}

export type AppleCredentialLifecycleCheckReason =
  | 'foreground'
  | 'credential-revoked';

function verifiedAppleSubject(user: AppleCredentialVerifiedUser): string | null {
  const identities = (user.identities ?? []).filter((identity) => identity.provider === 'apple');
  if (identities.length !== 1) return null;
  const identity = identities[0];
  const subject = identity.identity_data?.sub;
  if (typeof subject === 'string' && subject.trim()) return subject;
  return typeof identity.id === 'string' && identity.id.trim() ? identity.id : null;
}

/**
 * Resolves an account identity from a server-verified Supabase user. Native
 * Apple authorization is checked before that UID can open cloud sync.
 */
export async function resolveNativeAppleAccountIdentity({
  platform,
  user,
  authorizedState,
  credentialRevoked = false,
  getCredentialState,
}: {
  platform: AppleCredentialPlatform;
  user: AppleCredentialVerifiedUser;
  authorizedState: number;
  credentialRevoked?: boolean;
  getCredentialState(subject: string): Promise<number>;
}): Promise<AccountBootstrapIdentity | RevokedAppleAccountIdentity> {
  const identity = baseIdentity(user);
  if (platform !== 'ios' || identity.kind !== 'account' || identity.provider !== 'apple') {
    return identity;
  }

  const subject = verifiedAppleSubject(user);
  if (!subject) return reauthenticationIdentity(identity);
  if (credentialRevoked) {
    return { kind: 'revoked-apple-account', userId: identity.userId };
  }
  try {
    const state = await getCredentialState(subject);
    return state === authorizedState
      ? identity
      : { kind: 'revoked-apple-account', userId: identity.userId };
  } catch {
    // Simulator/unavailable/native failures are deliberately fail-closed and
    // never exposed to UI because they can contain the Apple subject.
    return reauthenticationIdentity(identity);
  }
}

/** Installs process-lifetime iOS foreground and credential-revoked triggers. */
export function createAppleCredentialLifecycleBinding({
  platform,
  appState,
  shouldCheck,
  addRevokeListener,
  onCheckStarted,
  reverify,
}: {
  platform: AppleCredentialPlatform;
  appState: AppleCredentialLifecycleAppState;
  shouldCheck(): boolean;
  addRevokeListener(listener: () => void): { remove(): void };
  onCheckStarted(): void;
  reverify(reason: AppleCredentialLifecycleCheckReason): Promise<unknown>;
}) {
  let active = true;
  let previousAppState = appState.currentState;
  let tail: Promise<void> = Promise.resolve();
  let appStateSubscription: { remove(): void } | null = null;
  let revokeSubscription: { remove(): void } | null = null;

  const trigger = (reason: AppleCredentialLifecycleCheckReason) => {
    if (!active || !shouldCheck()) return;
    // Freeze cloud work synchronously; native verification is asynchronous.
    onCheckStarted();
    tail = tail.then(async () => {
      if (!active) return;
      await reverify(reason);
    }).catch(() => {
      // The caller already froze access. A later foreground or explicit
      // reauthentication can retry without surfacing provider errors.
    });
  };

  if (platform === 'ios') {
    appStateSubscription = appState.addEventListener('change', (nextState) => {
      const wasInactive = /inactive|background/.test(previousAppState);
      previousAppState = nextState;
      if (wasInactive && nextState === 'active') trigger('foreground');
    });
    revokeSubscription = addRevokeListener(() => trigger('credential-revoked'));
  }

  return {
    async whenIdle() {
      await tail;
    },
    stop() {
      if (!active) return;
      active = false;
      appStateSubscription?.remove();
      revokeSubscription?.remove();
    },
  };
}
