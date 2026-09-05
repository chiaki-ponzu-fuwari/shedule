import {
  connectBackupIdentity,
  type AuthGateway,
  type BackupIdentityProvider,
  type ExistingProviderSession,
  type LinkIdentityResult,
} from '../../lib/account/connectBackupIdentity';

function fakeAuthGateway(options: {
  currentUserId?: string;
  currentIsAnonymous?: boolean;
  linkResult?: LinkIdentityResult;
  existingResult?: ExistingProviderSession | { status: 'cancelled' };
  completeResultUserId?: string;
  completeError?: Error;
} = {}) {
  let activeUserId = options.currentUserId ?? 'guest-1';
  const calls: unknown[][] = [];
  const existingResult = options.existingResult ?? {
    status: 'authenticated' as const,
    userId: 'account-9',
    accessToken: 'target-access-token',
    refreshToken: 'target-refresh-token',
  };

  const gateway: AuthGateway = {
    async getCurrentIdentity() {
      calls.push(['getCurrentIdentity']);
      return {
        userId: activeUserId,
        isAnonymous: options.currentIsAnonymous ?? true,
      };
    },
    async linkIdentity(provider, scopes) {
      calls.push(['linkIdentity', provider, scopes]);
      return options.linkResult ?? { status: 'linked', userId: activeUserId };
    },
    async startMerge(sourceUserId) {
      calls.push(['startMerge', sourceUserId]);
      return { intentId: 'intent-1', nonce: 'one-time-merge-nonce' };
    },
    async authenticateExistingIdentity(provider, scopes, intent) {
      calls.push(['authenticateExistingIdentity', provider, scopes, intent.intentId]);
      return existingResult;
    },
    async completeMerge(input) {
      calls.push(['completeMerge', input.intentId, input.sourceUserId, input.targetUserId]);
      if (options.completeError) throw options.completeError;
      return { userId: options.completeResultUserId ?? input.targetUserId };
    },
    async activateSession(session) {
      calls.push(['activateSession', session.userId]);
      activeUserId = session.userId;
    },
    async cancelMerge(intentId) {
      calls.push(['cancelMerge', intentId]);
    },
  };

  return {
    gateway,
    calls,
    get activeUserId() {
      return activeUserId;
    },
  };
}

const connect = (
  provider: BackupIdentityProvider,
  fixture: ReturnType<typeof fakeAuthGateway>,
) => connectBackupIdentity({ provider, gateway: fixture.gateway });

describe('backup account identity flow', () => {
  test('links a new Google identity without changing the anonymous UID', async () => {
    const fixture = fakeAuthGateway();

    await expect(connect('google', fixture)).resolves.toEqual({
      status: 'connected',
      userId: 'guest-1',
    });
    expect(fixture.calls).toContainEqual([
      'linkIdentity',
      'google',
      ['openid', 'email'],
    ]);
    expect(fixture.calls.some(([name]) => name === 'activateSession')).toBe(false);
    expect(fixture.activeUserId).toBe('guest-1');
  });

  test('provider cancellation preserves the guest session', async () => {
    const fixture = fakeAuthGateway({ linkResult: { status: 'cancelled' } });

    await expect(connect('google', fixture)).resolves.toEqual({ status: 'cancelled' });
    expect(fixture.calls.some(([name]) => name === 'startMerge')).toBe(false);
    expect(fixture.calls.some(([name]) => name === 'activateSession')).toBe(false);
    expect(fixture.activeUserId).toBe('guest-1');
  });

  test('an owned identity merges through a transient session before activation', async () => {
    const fixture = fakeAuthGateway({
      linkResult: { status: 'identity-owned' },
    });

    await expect(connect('google', fixture)).resolves.toEqual({
      status: 'merged',
      userId: 'account-9',
    });
    expect(fixture.calls).toEqual([
      ['getCurrentIdentity'],
      ['linkIdentity', 'google', ['openid', 'email']],
      ['startMerge', 'guest-1'],
      ['authenticateExistingIdentity', 'google', ['openid', 'email'], 'intent-1'],
      ['completeMerge', 'intent-1', 'guest-1', 'account-9'],
      ['activateSession', 'account-9'],
    ]);
    expect(fixture.activeUserId).toBe('account-9');
  });

  test('cancelling existing-account authentication closes the merge intent', async () => {
    const fixture = fakeAuthGateway({
      linkResult: { status: 'identity-owned' },
      existingResult: { status: 'cancelled' },
    });

    await expect(connect('apple', fixture)).resolves.toEqual({ status: 'cancelled' });
    expect(fixture.calls).toContainEqual(['linkIdentity', 'apple', []]);
    expect(fixture.calls).toContainEqual(['cancelMerge', 'intent-1']);
    expect(fixture.calls.some(([name]) => name === 'completeMerge')).toBe(false);
    expect(fixture.activeUserId).toBe('guest-1');
  });

  test('merge failure never activates the target session', async () => {
    const fixture = fakeAuthGateway({
      linkResult: { status: 'identity-owned' },
      completeError: new Error('merge unavailable'),
    });

    await expect(connect('google', fixture)).rejects.toThrow('merge unavailable');
    expect(fixture.calls.some(([name]) => name === 'activateSession')).toBe(false);
    expect(fixture.activeUserId).toBe('guest-1');
  });

  test('rejects a linked response that silently changes the active UID', async () => {
    const fixture = fakeAuthGateway({
      linkResult: { status: 'linked', userId: 'account-9' },
    });

    await expect(connect('google', fixture)).rejects.toThrow(/changed/i);
    expect(fixture.activeUserId).toBe('guest-1');
  });

  test('rejects a mismatched merge result before session activation', async () => {
    const fixture = fakeAuthGateway({
      linkResult: { status: 'identity-owned' },
      completeResultUserId: 'other-account',
    });

    await expect(connect('google', fixture)).rejects.toThrow(/target/i);
    expect(fixture.calls.some(([name]) => name === 'activateSession')).toBe(false);
    expect(fixture.activeUserId).toBe('guest-1');
  });
});
