import {
  createAccountDeletionController,
  type AccountDeletionControllerDependencies,
} from '../../lib/account/accountDeletionController';

function fixture(overrides: Partial<AccountDeletionControllerDependencies> = {}) {
  const calls: string[] = [];
  const receipt = {
    version: 1 as const,
    ownerId: 'user-1',
    requestId: 'request-1',
    receiptSecret: 'a'.repeat(43),
    stage: 'challenged' as const,
    createdAt: '2026-09-05T00:00:00.000Z',
    manualRevocationRequired: false,
  };
  const dependencies: AccountDeletionControllerDependencies = {
    deletion: {
      begin: jest.fn(async () => { calls.push('begin'); return receipt; }),
      read: jest.fn(async () => receipt),
      execute: jest.fn(async () => {
        calls.push('delete');
        return { status: 'completed' as const, requestId: 'request-1', manualRevocationRequired: false };
      }),
      recover: jest.fn(async () => ({
        requestId: 'request-1', status: 'completed' as const,
        manualRevocationRequired: false, retryable: false,
      })),
      acknowledgeCompleted: jest.fn(async () => { calls.push('ack'); }),
    },
    reauthenticate: jest.fn(async () => {
      calls.push('reauth');
      return { status: 'reauthenticated' as const, userId: 'user-1', accessToken: 'fresh' };
    }),
    cleanup: jest.fn(async () => { calls.push('cleanup'); return { complete: true, errors: [] }; }),
    markDeletionPending: jest.fn(() => calls.push('pending')),
    markError: jest.fn(),
    ...overrides,
  };
  return { controller: createAccountDeletionController(dependencies), dependencies, calls, receipt };
}

describe('account deletion controller', () => {
  test('requires same-provider reauthentication before deleting a connected account', async () => {
    const f = fixture();
    await expect(f.controller.deleteAccount({
      ownerId: 'user-1',
      provider: 'google',
    })).resolves.toEqual({
      status: 'deleted',
      requestId: 'request-1',
      manualRevocationRequired: false,
    });

    expect(f.dependencies.reauthenticate).toHaveBeenCalledWith('google', 'user-1');
    expect(f.dependencies.deletion.execute).toHaveBeenCalledWith({
      ownerId: 'user-1',
      reauthenticationToken: 'fresh',
    });
    expect(f.calls).toEqual(['begin', 'reauth', 'pending', 'delete', 'cleanup', 'ack']);
  });

  test('passes an ephemeral Google provider token only to the deletion request', async () => {
    const f = fixture({
      reauthenticate: jest.fn(async () => ({
        status: 'reauthenticated' as const,
        userId: 'user-1',
        accessToken: 'fresh',
        providerToken: 'provider-token',
      })),
    });
    await f.controller.deleteAccount({ ownerId: 'user-1', provider: 'google' });
    expect(f.dependencies.deletion.execute).toHaveBeenCalledWith(expect.objectContaining({
      googleProviderToken: 'provider-token',
    }));
  });

  test('does not freeze or delete the account when provider login is cancelled', async () => {
    const f = fixture({
      reauthenticate: jest.fn(async () => ({ status: 'cancelled' as const })),
    });
    await expect(f.controller.deleteAccount({
      ownerId: 'user-1', provider: 'apple',
    })).resolves.toEqual({ status: 'cancelled' });
    expect(f.dependencies.markDeletionPending).not.toHaveBeenCalled();
    expect(f.dependencies.deletion.execute).not.toHaveBeenCalled();
  });

  test('lets an anonymous guest request deletion without impossible OAuth', async () => {
    const f = fixture();
    await f.controller.deleteAccount({ ownerId: 'user-1', provider: null });
    expect(f.dependencies.reauthenticate).not.toHaveBeenCalled();
    expect(f.dependencies.deletion.execute).toHaveBeenCalledWith({ ownerId: 'user-1' });
  });

  test('keeps the durable completion receipt until every local cleanup succeeds', async () => {
    const f = fixture({
      cleanup: jest.fn(async () => ({ complete: false, errors: ['disk unavailable'] })),
    });
    await expect(f.controller.deleteAccount({
      ownerId: 'user-1', provider: 'google',
    })).resolves.toEqual({
      status: 'local-cleanup-pending',
      requestId: 'request-1',
      errors: ['disk unavailable'],
    });
    expect(f.dependencies.deletion.acknowledgeCompleted).not.toHaveBeenCalled();
  });

  test('finishes local cleanup from a saved completed receipt after restart', async () => {
    const f = fixture();
    (f.dependencies.deletion.read as jest.Mock).mockResolvedValue({
      ...f.receipt,
      stage: 'completed',
      manualRevocationRequired: true,
    });
    await expect(f.controller.recover()).resolves.toEqual({
      status: 'deleted',
      requestId: 'request-1',
      manualRevocationRequired: true,
    });
    expect(f.dependencies.deletion.recover).not.toHaveBeenCalled();
    expect(f.calls).toEqual(['pending', 'cleanup', 'ack']);
  });

  test('resumes an already-authorized failed deletion without provider reauthentication', async () => {
    const f = fixture();
    (f.dependencies.deletion.recover as jest.Mock).mockResolvedValue({
      requestId: 'request-1',
      status: 'failed',
      manualRevocationRequired: false,
      retryable: true,
    });

    await expect(f.controller.recover()).resolves.toEqual({
      status: 'deleted',
      requestId: 'request-1',
      manualRevocationRequired: false,
    });
    expect(f.dependencies.reauthenticate).not.toHaveBeenCalled();
    expect(f.dependencies.deletion.execute).toHaveBeenCalledWith({ ownerId: 'user-1' });
    expect(f.calls).toEqual(['pending', 'delete', 'cleanup', 'ack']);
  });

  test.each(['processing', 'db-cleared'] as const)(
    'continues the durable %s phase without asking the provider again',
    async (status) => {
      const f = fixture();
      (f.dependencies.deletion.recover as jest.Mock).mockResolvedValue({
        requestId: 'request-1',
        status,
        manualRevocationRequired: false,
        retryable: true,
      });

      await expect(f.controller.recover()).resolves.toMatchObject({ status: 'deleted' });
      expect(f.dependencies.reauthenticate).not.toHaveBeenCalled();
      expect(f.dependencies.deletion.execute).toHaveBeenCalledWith({ ownerId: 'user-1' });
    },
  );

  test('does not expose provider or database error details to account UI state', async () => {
    const f = fixture({
      reauthenticate: jest.fn(async () => {
        throw new Error('apple refresh_token=private-value');
      }),
    });

    const result = await f.controller.deleteAccount({
      ownerId: 'user-1', provider: 'apple',
    });

    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(f.dependencies.markError).not.toHaveBeenCalledWith(
      expect.stringContaining('private-value'),
    );
  });
});
