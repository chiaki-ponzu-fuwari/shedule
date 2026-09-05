import {
  clearDeletedAccountLocally,
  selectDeletedAccountStorageKeys,
  type AccountDeletionCleanupDependencies,
} from '../../lib/account/accountDeletionCleanup';

describe('post-deletion local cleanup', () => {
  test('selects only the deleted user and this installation guest namespaces', () => {
    expect(selectDeletedAccountStorageKeys({
      ownerId: 'user-1',
      installationId: 'install-1',
      keys: [
        'recoto:user:user-1:calendar',
        'recoto:user:user-10:calendar',
        'recoto:user:user-2:stamps',
        'recoto:guest:install-1:calendar',
        'recoto:guest:install-2:calendar',
        'recoto:account-bootstrap-binding:v1',
        'group-storage-v2',
        'google-auth-storage',
        'google-sync-settings',
        'app-locale',
      ],
    })).toEqual([
      'recoto:user:user-1:calendar',
      'recoto:guest:install-1:calendar',
      'recoto:account-bootstrap-binding:v1',
      'group-storage-v2',
      'google-auth-storage',
      'google-sync-settings',
    ]);
  });

  test('attempts every cleanup surface and reports a retryable partial failure', async () => {
    const calls: string[] = [];
    const dependencies: AccountDeletionCleanupDependencies = {
      readInstallationId: async () => 'install-1',
      listStorageKeys: async () => [
        'recoto:user:user-1:calendar',
        'recoto:guest:install-1:stamps',
      ],
      removeStorageKeys: async (keys) => {
        calls.push(`remove:${keys.join(',')}`);
        throw new Error('disk unavailable');
      },
      cancelNotifications: async () => { calls.push('notifications'); },
      disconnectGoogleCalendar: async () => { calls.push('google'); },
      clearAuthSession: async () => { calls.push('auth'); },
      clearAuthOperations: async () => { calls.push('auth-operations'); },
      clearPersonalMedia: async () => { calls.push('personal-media'); },
      resetGroupState: () => { calls.push('groups'); },
      selectEmptyGuest: async () => { calls.push('guest'); },
      resetAccountState: () => { calls.push('reset'); },
    };

    await expect(clearDeletedAccountLocally(dependencies, 'user-1')).resolves.toEqual({
      complete: false,
      errors: ['personal-storage: disk unavailable'],
    });
    expect(calls).toEqual([
      'notifications',
      'google',
      'auth',
      'auth-operations',
      'personal-media',
      'groups',
      'remove:recoto:user:user-1:calendar,recoto:guest:install-1:stamps',
      'guest',
      'reset',
    ]);
  });

  test('does not report success until removed namespaces are verified absent', async () => {
    const keys = new Set([
      'recoto:user:user-1:calendar',
      'recoto:guest:install-1:stamps',
    ]);
    const dependencies: AccountDeletionCleanupDependencies = {
      readInstallationId: async () => 'install-1',
      listStorageKeys: async () => [...keys],
      removeStorageKeys: async (selected) => selected.forEach((key) => keys.delete(key)),
      cancelNotifications: async () => undefined,
      disconnectGoogleCalendar: async () => undefined,
      clearAuthSession: async () => undefined,
      clearAuthOperations: async () => undefined,
      clearPersonalMedia: async () => undefined,
      resetGroupState: () => undefined,
      selectEmptyGuest: async () => undefined,
      resetAccountState: () => undefined,
    };

    await expect(clearDeletedAccountLocally(dependencies, 'user-1')).resolves.toEqual({
      complete: true,
      errors: [],
    });
  });

  test('keeps durable personal pointers when physical media cleanup must be retried', async () => {
    const removeStorageKeys = jest.fn(async () => undefined);
    const dependencies: AccountDeletionCleanupDependencies = {
      readInstallationId: async () => 'install-1',
      listStorageKeys: async () => ['recoto:user:user-1:personal-media-sync-v1'],
      removeStorageKeys,
      cancelNotifications: async () => undefined,
      disconnectGoogleCalendar: async () => undefined,
      clearAuthSession: async () => undefined,
      clearAuthOperations: async () => undefined,
      clearPersonalMedia: async () => { throw new Error('staged JPEG is still present'); },
      resetGroupState: () => undefined,
      selectEmptyGuest: async () => undefined,
      resetAccountState: () => undefined,
    };

    await expect(clearDeletedAccountLocally(dependencies, 'user-1')).resolves.toEqual({
      complete: false,
      errors: ['personal-media: staged JPEG is still present'],
    });
    expect(removeStorageKeys).not.toHaveBeenCalled();
  });
});
