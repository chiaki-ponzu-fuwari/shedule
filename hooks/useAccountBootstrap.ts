import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as AppleAuthentication from 'expo-apple-authentication';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import type { BackupIdentityProvider } from '../lib/account/connectBackupIdentity';
import {
  createAccountBootstrapCoordinator,
  type AccountBootstrapGate,
  type AccountBootstrapIdentity,
} from '../lib/account/accountBootstrap';
import { createAccountBootstrapRetryScheduler } from '../lib/account/accountBootstrapRetry';
import { createProductionAccountBootstrapRuntime } from '../lib/account/accountBootstrapPersistence';
import {
  createSupabaseCloudRepository,
  type SupabaseCloudClient,
} from '../lib/account/supabaseCloudRepository';
import { recoverPendingAccountDeletion } from '../lib/account/productionAccountDeletionController';
import { getSupabaseClient } from '../lib/supabase';
import { useAccountStore } from '../store/accountStore';
import {
  getAccountOAuthOperationJournal,
  resumePendingAccountAuthOperation,
} from './useAccountAuth';
import type { AccountDeletionControllerResult } from '../lib/account/accountDeletionController';
import {
  createAppleCredentialLifecycleBinding,
  resolveNativeAppleAccountIdentity,
  type AppleCredentialVerifiedUser,
} from '../lib/account/appleCredentialLifecycle';
import {
  clearRevokedAppleAccountLocally,
  recoverPendingAppleRevocationCleanup,
} from '../lib/account/productionAppleRevocationCleanup';

export function deletionRecoveryBlocksBootstrap(
  result: AccountDeletionControllerResult,
): boolean {
  return result.status === 'deletion-pending'
    || result.status === 'local-cleanup-pending';
}

const APPLE_REVOCATION_CLEANUP_PENDING =
  'Appleとの接続解除後の端末データを安全に消去しています。再試行してください。';

export interface VerifiedAccountUser extends AppleCredentialVerifiedUser {}

interface AuthObservationError {
  message?: string;
}

interface AuthObservationSession {
  user: { id: string };
}

export interface AccountAuthObservationClient {
  auth: {
    onAuthStateChange(
      callback: (event: string, session: AuthObservationSession | null) => void,
    ): { data: { subscription: { unsubscribe(): void } } };
    getUser(): Promise<{
      data: { user: VerifiedAccountUser | null };
      error: AuthObservationError | null;
    }>;
    getSession(): Promise<{
      data: { session: AuthObservationSession | null };
      error: AuthObservationError | null;
    }>;
  };
}

export interface AccountIdentityResolutionContext {
  credentialRevoked: boolean;
}

function supportedProvider(user: VerifiedAccountUser): BackupIdentityProvider | null {
  const candidates = [
    user.app_metadata?.provider,
    ...(Array.isArray(user.app_metadata?.providers) ? user.app_metadata.providers : []),
    ...(user.identities ?? []).map((identity) => identity.provider),
  ];
  for (const candidate of candidates) {
    if (candidate === 'google' || candidate === 'apple') return candidate;
  }
  return null;
}

export function accountIdentityFromVerifiedUser(
  user: VerifiedAccountUser,
): AccountBootstrapIdentity {
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

export function createVerifiedAccountObserver({
  client,
  observe,
  resolveIdentity = accountIdentityFromVerifiedUser,
  onVerificationStarted,
}: {
  client: AccountAuthObservationClient;
  observe(
    identity: AccountBootstrapIdentity,
    observation: { isCurrent(): boolean },
  ): Promise<unknown> | unknown;
  resolveIdentity?(
    user: VerifiedAccountUser,
    context: AccountIdentityResolutionContext,
  ): Promise<AccountBootstrapIdentity> | AccountBootstrapIdentity;
  onVerificationStarted?: () => void;
}) {
  let active = true;
  let verificationGeneration = 0;
  const pending = new Set<Promise<void>>();

  const track = (operation: Promise<void>) => {
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
    return operation;
  };

  const consume = (
    session: AuthObservationSession | null,
    context: AccountIdentityResolutionContext = { credentialRevoked: false },
  ) => {
    const startedAtGeneration = ++verificationGeneration;
    const observation = {
      isCurrent: () => active && startedAtGeneration === verificationGeneration,
    };
    return track((async () => {
      if (!session?.user?.id) {
        if (observation.isCurrent()) {
          await observe({ kind: 'guest-local' }, observation);
        }
        return;
      }

      try {
        const response = await client.auth.getUser();
        if (!active || startedAtGeneration !== verificationGeneration) return;
        if (response.error || !response.data.user || response.data.user.id !== session.user.id) {
          throw new Error('The restored session could not be verified');
        }
        const resolvedIdentity = resolveIdentity(response.data.user, context);
        const identity = resolvedIdentity instanceof Promise
          ? await resolvedIdentity
          : resolvedIdentity;
        if (!active || startedAtGeneration !== verificationGeneration) return;
        await observe(identity, observation);
      } catch (error) {
        if (!active || startedAtGeneration !== verificationGeneration) return;
        await observe({ kind: 'verification-failed', error }, observation);
      }
    })());
  };

  const { data } = client.auth.onAuthStateChange((_event, session) => {
    // Hide owner-scoped UI synchronously. Server verification is deliberately
    // asynchronous, so waiting until getUser() resolves could expose the prior UID.
    onVerificationStarted?.();
    // Returning immediately avoids awaiting another Supabase Auth call from inside
    // onAuthStateChange. Verification continues out-of-band and is generation guarded.
    void Promise.resolve().then(() => consume(session));
  });

  return {
    async retry(context: AccountIdentityResolutionContext = { credentialRevoked: false }) {
      const retryGeneration = ++verificationGeneration;
      try {
        const response = await client.auth.getSession();
        if (!active || retryGeneration !== verificationGeneration) return;
        if (response.error) throw new Error('The stored session could not be read');
        await consume(response.data.session, context);
      } catch (error) {
        if (!active || retryGeneration !== verificationGeneration) return;
        await observe(
          { kind: 'verification-failed', error },
          { isCurrent: () => active && retryGeneration === verificationGeneration },
        );
      }
    },

    async whenIdle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
      // Auth callbacks schedule consume() in a microtask.
      await Promise.resolve();
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },

    stop() {
      active = false;
      verificationGeneration += 1;
      data.subscription.unsubscribe();
    },
  };
}

export function useAccountBootstrap({ enabled = true }: { enabled?: boolean } = {}) {
  const client = getSupabaseClient();
  const [gate, setGate] = useState<AccountBootstrapGate>({ status: 'bootstrapping' });
  const [startupAttempt, setStartupAttempt] = useState(0);
  const observerRef = useRef<ReturnType<typeof createVerifiedAccountObserver> | null>(null);

  const coordinator = useMemo(() => {
    const runtime = createProductionAccountBootstrapRuntime();
    const repository = client
      ? createSupabaseCloudRepository(client as unknown as SupabaseCloudClient)
      : null;
    return createAccountBootstrapCoordinator({
      owners: runtime.owners,
      persistence: runtime.persistence,
      outbox: runtime.outbox,
      repository,
      account: {
        resetToGuest: () => useAccountStore.getState().resetToGuest(),
        setGuestConnected: (userId) => useAccountStore.getState().setGuestConnected(userId),
        markConnected: (details) => useAccountStore.getState().markConnected(details),
        markSyncing: () => useAccountStore.getState().markSyncing(),
        markSynced: (at) => useAccountStore.getState().markSynced(at),
        markConflictBackedUp: (at) => useAccountStore.getState().markConflictBackedUp(at),
        markOffline: (message) => useAccountStore.getState().markOffline(message),
        markReauthRequired: (message) => useAccountStore.getState().markReauthRequired(message),
        markError: (message) => useAccountStore.getState().markError(message),
      },
      onGateChange: setGate,
    });
  }, [client]);

  const retry = useCallback(async () => {
    // A safe failure is memoized by the coordinator so duplicate auth events do
    // not repeat migrations. An explicit/automatic retry must clear that memo
    // before the observer verifies the persisted session again.
    coordinator.invalidate();
    try {
      const revocationRecovery = await recoverPendingAppleRevocationCleanup();
      if (revocationRecovery.status === 'pending') {
        setGate({ status: 'blocked', message: APPLE_REVOCATION_CLEANUP_PENDING });
        return;
      }
    } catch {
      setGate({ status: 'blocked', message: APPLE_REVOCATION_CLEANUP_PENDING });
      return;
    }
    const observer = observerRef.current;
    if (observer) {
      await observer.retry();
    } else {
      // Deletion recovery and early startup failures happen before an auth
      // observer exists. Remount only that startup pipeline in this case.
      setStartupAttempt((current) => current + 1);
    }
  }, [coordinator]);

  const retryScheduler = useMemo(() => createAccountBootstrapRetryScheduler({
    canRetry: (expectedOwnerId) => {
      const account = useAccountStore.getState();
      return account.mode === 'account-connected'
        && account.userId === expectedOwnerId
        && account.connectivity === 'offline'
        && account.syncPhase !== 'reauth-required';
    },
    retry: () => { void retry(); },
  }), [retry]);

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    let observer: ReturnType<typeof createVerifiedAccountObserver> | null = null;
    let appleLifecycle: ReturnType<typeof createAppleCredentialLifecycleBinding> | null = null;
    void (async () => {
      try {
        const revocationRecovery = await recoverPendingAppleRevocationCleanup();
        if (!active) return;
        if (revocationRecovery.status === 'pending') {
          setGate({ status: 'blocked', message: APPLE_REVOCATION_CLEANUP_PENDING });
          return;
        }
        if (!client) {
          void coordinator.observe({ kind: 'guest-local' });
          return;
        }
        const deletionRecovery = await recoverPendingAccountDeletion();
        if (!active) return;
        if (deletionRecoveryBlocksBootstrap(deletionRecovery)) {
          setGate({
            status: 'blocked',
            message: 'アカウント削除を安全に完了しています。通信を確認して再試行してください。',
          });
          return;
        }
        // A journaled OAuth merge may have removed the source Auth user already.
        // Resume/activate it before any UID is allowed to choose a local namespace.
        const resumedOperation = await resumePendingAccountAuthOperation();
        if (!active) return;
        let repairUserId = resumedOperation.status === 'repair-required'
          ? resumedOperation.userId
          : null;
        observer = createVerifiedAccountObserver({
          client: client as unknown as AccountAuthObservationClient,
          resolveIdentity: async (user, context) => {
            const identity = await resolveNativeAppleAccountIdentity({
              platform: Platform.OS === 'ios'
                ? 'ios'
                : Platform.OS === 'android' ? 'android' : 'web',
              user,
              authorizedState: AppleAuthentication.AppleAuthenticationCredentialState.AUTHORIZED,
              credentialRevoked: context.credentialRevoked,
              getCredentialState: (subject) =>
                AppleAuthentication.getCredentialStateAsync(subject),
            });
            if (identity.kind === 'revoked-apple-account') {
              const cleanup = await clearRevokedAppleAccountLocally(identity.userId);
              if (cleanup.status !== 'cleared') {
                throw new Error('Apple revocation local cleanup is incomplete');
              }
              return { kind: 'guest-local' };
            }
            return identity;
          },
          observe: async (identity, observation) => {
            const result = await coordinator.observe(identity);
            if (
              repairUserId !== null
              && identity.kind === 'account'
              && identity.userId === repairUserId
              && result.status !== 'superseded'
              && (result.status === 'ready' || result.status === 'safe-failure')
              && observation.isCurrent()
            ) {
              const currentOperation = await getAccountOAuthOperationJournal().read();
              if (!observation.isCurrent()) return result;
              if (
                currentOperation?.expectedUserId === identity.userId
                && (
                  currentOperation.kind === 'apple-credential-repair'
                  || currentOperation.stage === 'credential-repair-required'
                )
              ) {
                useAccountStore.getState().markReauthRequired();
              } else {
                repairUserId = null;
              }
            }
            return result;
          },
          onVerificationStarted: () => coordinator.invalidate(),
        });
        observerRef.current = observer;
        appleLifecycle = createAppleCredentialLifecycleBinding({
          platform: Platform.OS === 'ios'
            ? 'ios'
            : Platform.OS === 'android' ? 'android' : 'web',
          appState: {
            currentState: AppState.currentState,
            addEventListener: (_event, listener) => AppState.addEventListener(
              'change',
              listener as (state: AppStateStatus) => void,
            ),
          },
          shouldCheck: () => {
            const account = useAccountStore.getState();
            return account.mode === 'account-connected'
              && account.provider === 'apple'
              && Boolean(account.userId);
          },
          addRevokeListener: (listener) => AppleAuthentication.addRevokeListener(listener),
          onCheckStarted: () => {
            const account = useAccountStore.getState();
            if (account.mode !== 'account-connected' || account.provider !== 'apple') return;
            account.markReauthRequired();
            coordinator.invalidate();
          },
          reverify: (reason) => observer?.retry({
            credentialRevoked: reason === 'credential-revoked',
          }) ?? Promise.resolve(),
        });
        // This also covers SDK versions/environments where INITIAL_SESSION is delayed.
        void observer.retry();
      } catch (error) {
        if (active) void coordinator.observe({ kind: 'verification-failed', error });
      }
    })();
    return () => {
      active = false;
      appleLifecycle?.stop();
      if (observerRef.current === observer) observerRef.current = null;
      observer?.stop();
    };
  }, [client, coordinator, enabled, startupAttempt]);

  useEffect(() => {
    retryScheduler.update(enabled ? gate : { status: 'blocked', message: 'disabled' });
  }, [enabled, gate, retryScheduler]);

  useEffect(() => () => retryScheduler.stop(), [retryScheduler]);

  return { ...gate, retry };
}
