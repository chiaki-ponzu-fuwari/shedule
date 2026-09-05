jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import {
  accountIdentityFromVerifiedUser,
  createVerifiedAccountObserver,
  deletionRecoveryBlocksBootstrap,
  type AccountAuthObservationClient,
} from '../../hooks/useAccountBootstrap';
import type { AccountBootstrapIdentity } from '../../lib/account/accountBootstrap';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function clientFixture() {
  let callback: ((event: string, session: { user: { id: string } } | null) => void) | null = null;
  const unsubscribe = jest.fn();
  const getUser = jest.fn();
  const getSession = jest.fn();
  const client: AccountAuthObservationClient = {
    auth: {
      onAuthStateChange: (next) => {
        callback = next;
        return { data: { subscription: { unsubscribe } } };
      },
      getUser,
      getSession,
    },
  };
  return {
    client,
    getUser,
    getSession,
    unsubscribe,
    emit: (event: string, session: { user: { id: string } } | null) => callback?.(event, session),
  };
}

describe('verified account auth observation', () => {
  test('keeps owner-scoped routes closed while durable deletion is unfinished', () => {
    expect(deletionRecoveryBlocksBootstrap({
      status: 'deletion-pending',
      requestId: 'request-1',
      error: 'offline',
    })).toBe(true);
    expect(deletionRecoveryBlocksBootstrap({ status: 'confirmation-required' })).toBe(false);
    expect(deletionRecoveryBlocksBootstrap({
      status: 'deleted',
      requestId: 'request-1',
      manualRevocationRequired: false,
    })).toBe(false);
  });

  test('normalizes only supported providers from a server-verified user', () => {
    expect(accountIdentityFromVerifiedUser({
      id: 'user-a',
      email: 'a@example.com',
      is_anonymous: false,
      app_metadata: { provider: 'google' },
    })).toEqual({
      kind: 'account',
      userId: 'user-a',
      provider: 'google',
      email: 'a@example.com',
    });
    expect(accountIdentityFromVerifiedUser({
      id: 'anon-1',
      is_anonymous: true,
    })).toEqual({ kind: 'anonymous', userId: 'anon-1' });
    expect(() => accountIdentityFromVerifiedUser({
      id: 'password-user',
      is_anonymous: false,
      app_metadata: { provider: 'email' },
    })).toThrow('supported provider');
  });

  test('does not select a session user until getUser verifies the same uid', async () => {
    const fixture = clientFixture();
    const identities: AccountBootstrapIdentity[] = [];
    fixture.getUser.mockResolvedValue({
      data: {
        user: {
          id: 'different-user',
          is_anonymous: false,
          app_metadata: { provider: 'google' },
        },
      },
      error: null,
    });
    const observer = createVerifiedAccountObserver({
      client: fixture.client,
      observe: async (identity) => { identities.push(identity); },
    });

    fixture.emit('INITIAL_SESSION', { user: { id: 'claimed-user' } });
    await observer.whenIdle();

    expect(identities).toHaveLength(1);
    expect(identities[0].kind).toBe('verification-failed');
    expect(identities).not.toContainEqual(expect.objectContaining({ userId: 'claimed-user' }));
    observer.stop();
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('gates owner-scoped UI synchronously when any auth event starts verification', () => {
    const fixture = clientFixture();
    const onVerificationStarted = jest.fn();
    fixture.getUser.mockReturnValue(new Promise(() => undefined));
    const observer = createVerifiedAccountObserver({
      client: fixture.client,
      observe: jest.fn(),
      onVerificationStarted,
    });

    fixture.emit('SIGNED_IN', { user: { id: 'user-b' } });

    expect(onVerificationStarted).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  test('ignores an older verification response after a newer auth event', async () => {
    const fixture = clientFixture();
    const first = deferred<{
      data: { user: { id: string; is_anonymous: false; app_metadata: { provider: 'google' } } };
      error: null;
    }>();
    fixture.getUser
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        data: {
          user: {
            id: 'user-b',
            is_anonymous: false,
            app_metadata: { provider: 'apple' },
          },
        },
        error: null,
      });
    const identities: AccountBootstrapIdentity[] = [];
    const observer = createVerifiedAccountObserver({
      client: fixture.client,
      observe: async (identity) => { identities.push(identity); },
    });

    fixture.emit('SIGNED_IN', { user: { id: 'user-a' } });
    fixture.emit('SIGNED_IN', { user: { id: 'user-b' } });
    first.resolve({
      data: {
        user: {
          id: 'user-a',
          is_anonymous: false,
          app_metadata: { provider: 'google' },
        },
      },
      error: null,
    });
    await observer.whenIdle();

    expect(identities).toEqual([{
      kind: 'account',
      userId: 'user-b',
      provider: 'apple',
      email: null,
    }]);
  });

  test('marks post-bootstrap work stale when auth changes while observe is still running', async () => {
    const fixture = clientFixture();
    fixture.getUser
      .mockResolvedValueOnce({
        data: { user: { id: 'user-a', is_anonymous: false, app_metadata: { provider: 'google' } } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { user: { id: 'user-b', is_anonymous: false, app_metadata: { provider: 'apple' } } },
        error: null,
      });
    const firstObserve = deferred<void>();
    let firstIsCurrent: (() => boolean) | null = null;
    const identities: string[] = [];
    const observer = createVerifiedAccountObserver({
      client: fixture.client,
      observe: async (identity, observation) => {
        if (identity.kind !== 'account') return;
        identities.push(identity.userId);
        if (identity.userId === 'user-a') {
          firstIsCurrent = observation.isCurrent;
          await firstObserve.promise;
        }
      },
    });

    fixture.emit('SIGNED_IN', { user: { id: 'user-a' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(firstIsCurrent).not.toBeNull();
    fixture.emit('SIGNED_IN', { user: { id: 'user-b' } });
    await Promise.resolve();
    expect(firstIsCurrent!()).toBe(false);
    firstObserve.resolve();
    await observer.whenIdle();

    expect(identities).toEqual(['user-a', 'user-b']);
  });

  test('a signed-out event selects guest without making a verification request', async () => {
    const fixture = clientFixture();
    const identities: AccountBootstrapIdentity[] = [];
    const observer = createVerifiedAccountObserver({
      client: fixture.client,
      observe: async (identity) => { identities.push(identity); },
    });

    fixture.emit('SIGNED_OUT', null);
    await observer.whenIdle();

    expect(fixture.getUser).not.toHaveBeenCalled();
    expect(identities).toEqual([{ kind: 'guest-local' }]);
  });

  test('retry re-reads the stored session and goes through server verification', async () => {
    const fixture = clientFixture();
    fixture.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
      error: null,
    });
    fixture.getUser.mockResolvedValue({
      data: {
        user: {
          id: 'user-a',
          email: 'a@example.com',
          is_anonymous: false,
          app_metadata: { provider: 'google' },
        },
      },
      error: null,
    });
    const identities: AccountBootstrapIdentity[] = [];
    const observer = createVerifiedAccountObserver({
      client: fixture.client,
      observe: async (identity) => { identities.push(identity); },
    });

    await observer.retry();
    await observer.whenIdle();

    expect(identities).toEqual([expect.objectContaining({ kind: 'account', userId: 'user-a' })]);
  });

  test('resolves native Apple credential state after server UID verification and before observation', async () => {
    const fixture = clientFixture();
    const verifiedUser = {
      id: 'user-apple',
      is_anonymous: false,
      app_metadata: { provider: 'apple' },
      identities: [{ provider: 'apple' }],
    };
    fixture.getUser.mockResolvedValue({ data: { user: verifiedUser }, error: null });
    const resolveIdentity = jest.fn(async () => ({
      kind: 'reauth-required-account' as const,
      userId: 'user-apple',
      provider: 'apple' as const,
      email: null,
    }));
    const identities: AccountBootstrapIdentity[] = [];
    const observer = createVerifiedAccountObserver({
      client: fixture.client,
      resolveIdentity,
      observe: async (identity) => { identities.push(identity); },
    });

    fixture.emit('INITIAL_SESSION', { user: { id: 'user-apple' } });
    await observer.whenIdle();

    expect(resolveIdentity).toHaveBeenCalledWith(verifiedUser, { credentialRevoked: false });
    expect(identities).toEqual([expect.objectContaining({
      kind: 'reauth-required-account',
      userId: 'user-apple',
    })]);
    observer.stop();
  });

  test('carries a native credential-revoked signal through fresh server verification', async () => {
    const fixture = clientFixture();
    const verifiedUser = {
      id: 'user-apple',
      is_anonymous: false,
      app_metadata: { provider: 'apple' },
      identities: [{ id: 'apple-subject', provider: 'apple' }],
    };
    fixture.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-apple' } } },
      error: null,
    });
    fixture.getUser.mockResolvedValue({ data: { user: verifiedUser }, error: null });
    const resolveIdentity = jest.fn(async () => ({ kind: 'guest-local' as const }));
    const observe = jest.fn(async () => undefined);
    const observer = createVerifiedAccountObserver({
      client: fixture.client,
      resolveIdentity,
      observe,
    });

    await observer.retry({ credentialRevoked: true });
    await observer.whenIdle();

    expect(resolveIdentity).toHaveBeenCalledWith(verifiedUser, { credentialRevoked: true });
    expect(observe).toHaveBeenCalledWith(
      { kind: 'guest-local' },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    observer.stop();
  });
});

test('root layout gates application routes until account bootstrap is safe', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const source = fs.readFileSync('app/_layout.tsx', 'utf8');

  expect(source).toContain('useAccountBootstrap');
  expect(source).toMatch(/bootstrap\.status === 'ready' \|\| bootstrap\.status === 'safe-failure'/);
  expect(source).toContain('<BootstrappedApplication />');
  expect(source.indexOf("bootstrap.status === 'ready'")).toBeLessThan(
    source.indexOf('<BootstrappedApplication />'),
  );
});

test('production bootstrap listens for native Apple revocation and foreground checks', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const source = fs.readFileSync('hooks/useAccountBootstrap.ts', 'utf8');

  expect(source).toContain('resolveNativeAppleAccountIdentity');
  expect(source).toContain('AppleAuthentication.getCredentialStateAsync');
  expect(source).toContain('AppleAuthentication.addRevokeListener');
  expect(source).toContain('createAppleCredentialLifecycleBinding');
  expect(source).toContain('AppState');
  expect(source).toContain('recoverPendingAppleRevocationCleanup');
  expect(source).toContain('clearRevokedAppleAccountLocally');
  expect(source.indexOf('recoverPendingAppleRevocationCleanup()')).toBeLessThan(
    source.indexOf('recoverPendingAccountDeletion()'),
  );
  expect(source).toMatch(/kind === 'revoked-apple-account'[\s\S]*clearRevokedAppleAccountLocally/);
  expect(source).toMatch(/credentialRevoked:\s*reason === 'credential-revoked'/);
});

test('production bootstrap automatically retries a safe offline initial migration', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const source = fs.readFileSync('hooks/useAccountBootstrap.ts', 'utf8');

  expect(source).toContain('createAccountBootstrapRetryScheduler');
  expect(source).toContain("account.connectivity === 'offline'");
  expect(source).toContain('retryScheduler.update(');
  expect(source).toContain('enabled ? gate');
  expect(source).toContain('retryScheduler.stop()');
  expect(source).toMatch(/coordinator\.invalidate\(\)[\s\S]*observerRef\.current[\s\S]*observer\.retry\(\)/);
  expect(source).toMatch(/if \(observer\)[\s\S]*setStartupAttempt/);
  expect(source).not.toContain('setAttempt(');
});
