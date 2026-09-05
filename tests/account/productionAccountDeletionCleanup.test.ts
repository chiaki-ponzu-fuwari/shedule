jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('expo-notifications', () => ({
  cancelAllScheduledNotificationsAsync: jest.fn(async () => undefined),
}));

jest.mock('../../hooks/useAccountAuth', () => ({
  getAccountOAuthOperationJournal: jest.fn(),
}));

describe('production post-deletion OAuth cleanup', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('cancels the active journal operation so transient session and PKCE artifacts are removed', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce({ operationId: 'operation-1' })
      .mockResolvedValueOnce(null);
    const cancel = jest.fn(async () => undefined);
    const { getAccountOAuthOperationJournal } = require('../../hooks/useAccountAuth') as {
      getAccountOAuthOperationJournal: jest.Mock;
    };
    getAccountOAuthOperationJournal.mockReturnValue({ read, cancel });

    const { clearProductionAccountOAuthOperations } = require(
      '../../lib/account/productionAccountDeletionCleanup'
    ) as typeof import('../../lib/account/productionAccountDeletionCleanup');

    await expect(clearProductionAccountOAuthOperations()).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('operation-1');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
