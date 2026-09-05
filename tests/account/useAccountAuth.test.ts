import {
  createAccountAuthController,
  type AccountAuthControllerDependencies,
} from '../../lib/account/accountAuthController';
import { AccountAuthError } from '../../lib/account/supabaseAuthGateway';

function fixture(
  result:
    | { status: 'connected' | 'merged'; userId: string }
    | { status: 'cancelled' }
    | Error,
) {
  const calls: unknown[][] = [];
  const dependencies: AccountAuthControllerDependencies = {
    ensureGuestSession: async () => {
      calls.push(['ensureGuestSession', 'account-link']);
      return 'guest-1';
    },
    connectIdentity: async (provider) => {
      calls.push(['connectIdentity', provider]);
      if (result instanceof Error) throw result;
      return result;
    },
    reauthenticateIdentity: async (provider, expectedUserId) => {
      calls.push(['reauthenticateIdentity', provider, expectedUserId]);
      if (result instanceof Error) throw result;
      if (result.status === 'cancelled') return result;
      return {
        status: 'reauthenticated' as const,
        userId: result.userId,
        accessToken: 'fresh-access-token',
      };
    },
    readConnectedUser: async () => ({
      id: result instanceof Error || result.status === 'cancelled' ? 'guest-1' : result.userId,
      email: 'owner@example.com',
    }),
    account: {
      beginConnection: (provider) => calls.push(['beginConnection', provider]),
      cancelConnection: () => calls.push(['cancelConnection']),
      markConnected: (details) => calls.push(['markConnected', details]),
      markOffline: (message) => calls.push(['markOffline', message]),
      markReauthRequired: (message) => calls.push(['markReauthRequired', message]),
      markError: (message) => calls.push(['markError', message]),
    },
  };
  return { controller: createAccountAuthController(dependencies), calls };
}

describe('account auth controller', () => {
  test('creates a cloud guest only after a user taps backup login', async () => {
    const setup = fixture({ status: 'connected', userId: 'guest-1' });

    await expect(setup.controller.connect('google')).resolves.toEqual({
      status: 'connected',
      userId: 'guest-1',
    });
    expect(setup.calls.slice(0, 3)).toEqual([
      ['beginConnection', 'google'],
      ['ensureGuestSession', 'account-link'],
      ['connectIdentity', 'google'],
    ]);
    expect(setup.calls).toContainEqual([
      'markConnected',
      { userId: 'guest-1', provider: 'google', email: 'owner@example.com' },
    ]);
  });

  test('treats provider dismissal as cancellation, not failure', async () => {
    const setup = fixture({ status: 'cancelled' });

    await expect(setup.controller.connect('apple')).resolves.toEqual({ status: 'cancelled' });
    expect(setup.calls).toContainEqual(['cancelConnection']);
    expect(setup.calls.some(([name]) => name === 'markError')).toBe(false);
  });

  test('maps reauthentication and connection failures to recoverable UI states', async () => {
    const reauth = fixture(new AccountAuthError('reauth-required', '再ログインが必要です'));
    await expect(reauth.controller.connect('google')).rejects.toThrow();
    expect(reauth.calls).toContainEqual([
      'markReauthRequired',
      'クラウド保存を続けるには、もう一度ログインが必要です。',
    ]);

    const offline = fixture(new AccountAuthError('offline', '予定は端末に保存されています'));
    await expect(offline.controller.connect('apple')).rejects.toThrow();
    expect(offline.calls).toContainEqual([
      'markOffline',
      'データ保存用アカウントに接続できませんでした。予定は端末に保存されています。',
    ]);
  });

  test('never exposes technical callback details in the user-facing error', async () => {
    const setup = fixture(
      new AccountAuthError(
        'invalid-callback',
        'Unexpected OAuth callback field: access_token=secret',
      ),
    );

    await expect(setup.controller.connect('google')).rejects.toThrow();
    const visibleError = setup.calls.find(([name]) => name === 'markError')?.[1];
    expect(visibleError).toBe('ログインを完了できませんでした。設定からもう一度お試しください。');
    expect(String(visibleError)).not.toContain('access_token');
  });

  test('does not trust technical text even when an error has a recoverable code', async () => {
    const setup = fixture(
      new AccountAuthError('offline', 'provider_debug_token=secret'),
    );

    await expect(setup.controller.connect('apple')).rejects.toThrow();
    const visibleError = setup.calls.find(([name]) => name === 'markOffline')?.[1];
    expect(visibleError).toBe(
      'データ保存用アカウントに接続できませんでした。予定は端末に保存されています。',
    );
    expect(String(visibleError)).not.toContain('secret');
  });

  test('uses dedicated isolated reauthentication without creating a new guest', async () => {
    const setup = fixture({ status: 'connected', userId: 'account-9' });

    await expect(setup.controller.reauthenticate('google', 'account-9')).resolves.toEqual({
      status: 'reauthenticated',
      userId: 'account-9',
      accessToken: 'fresh-access-token',
    });
    expect(setup.calls).toContainEqual([
      'reauthenticateIdentity',
      'google',
      'account-9',
    ]);
    expect(setup.calls.some(([name]) => name === 'ensureGuestSession')).toBe(false);
    expect(setup.calls.some(([name]) => name === 'connectIdentity')).toBe(false);
  });
});
