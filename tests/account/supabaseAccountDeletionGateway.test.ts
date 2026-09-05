import {
  createSupabaseAccountDeletionGateway,
  type AccountDeletionFunctionClient,
} from '../../lib/account/supabaseAccountDeletionGateway';

function fixture() {
  const calls: Array<[string, unknown]> = [];
  const client: AccountDeletionFunctionClient = {
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    functions: {
      invoke: jest.fn(async (name, options) => {
        calls.push([name, options?.body]);
        if (name === 'start-account-deletion') {
          return {
            data: { requestId: '11111111-1111-4111-8111-111111111111', expiresAt: 'later' },
            error: null,
          };
        }
        if (name === 'delete-account') {
          return {
            data: {
              deleted: true,
              requestId: '11111111-1111-4111-8111-111111111111',
              manualRevocationRequired: false,
            },
            error: null,
          };
        }
        return {
          data: {
            requestId: '11111111-1111-4111-8111-111111111111',
            status: 'completed',
            manualRevocationRequired: false,
            retryable: false,
          },
          error: null,
        };
      }),
    },
  };
  return { client, gateway: createSupabaseAccountDeletionGateway(client), calls };
}

describe('Supabase account deletion gateway', () => {
  test('derives account ownership from a verified Supabase user', async () => {
    const f = fixture();
    await f.gateway.start({
      ownerId: 'user-1',
      requestId: '11111111-1111-4111-8111-111111111111',
      receiptSecret: 'a'.repeat(43),
    });

    expect(f.client.auth.getUser).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual([[
      'start-account-deletion',
      {
        requestId: '11111111-1111-4111-8111-111111111111',
        receiptSecret: 'a'.repeat(43),
      },
    ]]);
  });

  test('rejects a local owner mismatch before invoking a privileged function', async () => {
    const f = fixture();
    await expect(f.gateway.deleteAccount({
      ownerId: 'user-2',
      requestId: '11111111-1111-4111-8111-111111111111',
      receiptSecret: 'a'.repeat(43),
      reauthenticationToken: 'fresh-token',
    })).rejects.toThrow(/verified account/i);
    expect(f.calls).toEqual([]);
  });

  test('uses the public receipt endpoint after the Auth user has been deleted', async () => {
    const f = fixture();
    (f.client.auth.getUser as jest.Mock).mockRejectedValue(new Error('session gone'));

    await expect(f.gateway.status({
      requestId: '11111111-1111-4111-8111-111111111111',
      receiptSecret: 'a'.repeat(43),
    })).resolves.toMatchObject({ status: 'completed' });
    expect(f.client.auth.getUser).not.toHaveBeenCalled();
    expect(f.calls[0]?.[0]).toBe('account-deletion-status');
  });

  test('rejects malformed function responses instead of losing the receipt', async () => {
    const f = fixture();
    (f.client.functions.invoke as jest.Mock).mockResolvedValue({
      data: { deleted: true, requestId: 'wrong' },
      error: null,
    });

    await expect(f.gateway.deleteAccount({
      ownerId: 'user-1',
      requestId: '11111111-1111-4111-8111-111111111111',
      receiptSecret: 'a'.repeat(43),
      reauthenticationToken: 'fresh-token',
    })).rejects.toThrow(/invalid response/i);
  });
});
