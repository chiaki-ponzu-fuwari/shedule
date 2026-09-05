import {
  createAppleCredentialLifecycleBinding,
  resolveNativeAppleAccountIdentity,
  type AppleCredentialLifecycleAppState,
} from '../../lib/account/appleCredentialLifecycle';

const appleUser = {
  id: 'user-apple',
  email: 'relay@privaterelay.appleid.com',
  is_anonymous: false,
  app_metadata: { provider: 'apple' },
  identities: [{
    id: 'apple-subject-1',
    provider: 'apple',
    identity_data: { sub: 'apple-subject-1' },
  }],
};

describe('native Apple credential lifecycle', () => {
  test('checks the server-verified Apple subject before allowing its UID to sync', async () => {
    const getCredentialState = jest.fn(async () => 1);

    await expect(resolveNativeAppleAccountIdentity({
      platform: 'ios',
      user: appleUser,
      authorizedState: 1,
      getCredentialState,
    })).resolves.toEqual({
      kind: 'account',
      userId: 'user-apple',
      provider: 'apple',
      email: 'relay@privaterelay.appleid.com',
    });
    expect(getCredentialState).toHaveBeenCalledWith('apple-subject-1');
  });

  test.each([0, 2, 3])(
    'marks a confirmed non-authorized Apple credential state %s for local account cleanup',
    async (credentialState) => {
      await expect(resolveNativeAppleAccountIdentity({
        platform: 'ios',
        user: appleUser,
        authorizedState: 1,
        getCredentialState: async () => credentialState,
      })).resolves.toEqual({
        kind: 'revoked-apple-account',
        userId: 'user-apple',
      });
    },
  );

  test('fails closed without exposing native errors or trusting an ambiguous Apple subject', async () => {
    await expect(resolveNativeAppleAccountIdentity({
      platform: 'ios',
      user: appleUser,
      authorizedState: 1,
      getCredentialState: async () => {
        throw new Error('native secret subject=apple-subject-1');
      },
    })).resolves.toEqual(expect.objectContaining({ kind: 'reauth-required-account' }));

    await expect(resolveNativeAppleAccountIdentity({
      platform: 'ios',
      user: {
        ...appleUser,
        identities: [
          ...appleUser.identities,
          { id: 'attacker-subject', provider: 'apple', identity_data: { sub: 'attacker-subject' } },
        ],
      },
      authorizedState: 1,
      getCredentialState: jest.fn(),
    })).resolves.toEqual(expect.objectContaining({ kind: 'reauth-required-account' }));
  });

  test('treats the native revoke notification as confirmed only after server Apple subject validation', async () => {
    const getCredentialState = jest.fn(async () => 1);

    await expect(resolveNativeAppleAccountIdentity({
      platform: 'ios',
      user: appleUser,
      authorizedState: 1,
      credentialRevoked: true,
      getCredentialState,
    })).resolves.toEqual({
      kind: 'revoked-apple-account',
      userId: 'user-apple',
    });
    expect(getCredentialState).not.toHaveBeenCalled();

    await expect(resolveNativeAppleAccountIdentity({
      platform: 'ios',
      user: { ...appleUser, identities: [] },
      authorizedState: 1,
      credentialRevoked: true,
      getCredentialState,
    })).resolves.toEqual(expect.objectContaining({ kind: 'reauth-required-account' }));
  });

  test('does nothing for guest, Google, and non-iOS identities', async () => {
    const getCredentialState = jest.fn();
    await expect(resolveNativeAppleAccountIdentity({
      platform: 'web',
      user: appleUser,
      authorizedState: 1,
      getCredentialState,
    })).resolves.toEqual(expect.objectContaining({ kind: 'account', provider: 'apple' }));
    await expect(resolveNativeAppleAccountIdentity({
      platform: 'ios',
      user: { id: 'guest-1', is_anonymous: true },
      authorizedState: 1,
      getCredentialState,
    })).resolves.toEqual({ kind: 'anonymous', userId: 'guest-1' });
    await expect(resolveNativeAppleAccountIdentity({
      platform: 'ios',
      user: {
        id: 'google-1',
        is_anonymous: false,
        app_metadata: { provider: 'google' },
        identities: [{ id: 'google-sub', provider: 'google' }],
      },
      authorizedState: 1,
      getCredentialState,
    })).resolves.toEqual(expect.objectContaining({ kind: 'account', provider: 'google' }));
    expect(getCredentialState).not.toHaveBeenCalled();
  });

  test('rechecks on foreground and credential-revoked notifications, freezing first', async () => {
    let appStateListener: ((state: string) => void) | null = null;
    let revokeListener: (() => void) | null = null;
    const appState: AppleCredentialLifecycleAppState = {
      currentState: 'background',
      addEventListener: (_event, listener) => {
        appStateListener = listener;
        return { remove: jest.fn() };
      },
    };
    const order: string[] = [];
    const binding = createAppleCredentialLifecycleBinding({
      platform: 'ios',
      appState,
      shouldCheck: () => true,
      addRevokeListener: (listener) => {
        revokeListener = listener;
        return { remove: jest.fn() };
      },
      onCheckStarted: () => order.push('freeze'),
      reverify: async (reason) => { order.push(`verify:${reason}`); },
    });

    appStateListener!('active');
    await binding.whenIdle();
    revokeListener!();
    await binding.whenIdle();

    expect(order).toEqual([
      'freeze',
      'verify:foreground',
      'freeze',
      'verify:credential-revoked',
    ]);
    binding.stop();
  });

  test('does not install native listeners outside iOS', async () => {
    const addAppState = jest.fn();
    const addRevokeListener = jest.fn();
    const binding = createAppleCredentialLifecycleBinding({
      platform: 'web',
      appState: { currentState: 'active', addEventListener: addAppState },
      shouldCheck: () => true,
      addRevokeListener,
      onCheckStarted: jest.fn(),
      reverify: jest.fn(),
    });

    expect(addAppState).not.toHaveBeenCalled();
    expect(addRevokeListener).not.toHaveBeenCalled();
    await binding.whenIdle();
    binding.stop();
  });
});
