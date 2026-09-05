import {
  ACCOUNT_DELETION_RECEIPT_KEY,
  createAccountDeletionCoordinator,
  type AccountDeletionGateway,
  type AccountDeletionStorage,
} from '../../lib/account/accountDeletion';

function fixture(options: {
  startFails?: boolean;
  deleteFails?: boolean;
  status?: 'challenged' | 'processing' | 'db-cleared' | 'completed' | 'failed';
} = {}) {
  const values = new Map<string, string>();
  const calls: unknown[][] = [];
  const storage: AccountDeletionStorage = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { calls.push(['store', key]); values.set(key, value); },
    async removeItem(key) { calls.push(['remove', key]); values.delete(key); },
  };
  const gateway: AccountDeletionGateway = {
    async start(input) {
      calls.push(['start', input]);
      expect(values.get(ACCOUNT_DELETION_RECEIPT_KEY)).toContain(input.receiptSecret);
      if (options.startFails) throw new Error('response lost');
      return {
        requestId: input.requestId,
        expiresAt: '2026-09-05T00:10:00.000Z',
      };
    },
    async deleteAccount(input) {
      calls.push(['delete', input]);
      if (options.deleteFails) throw new Error('offline');
      return {
        deleted: true,
        requestId: input.requestId,
        manualRevocationRequired: true,
      };
    },
    async status(input) {
      calls.push(['status', input]);
      return {
        requestId: input.requestId,
        status: options.status ?? 'completed',
        manualRevocationRequired: true,
        retryable: true,
      };
    },
  };
  const coordinator = createAccountDeletionCoordinator({
    storage,
    gateway,
    now: () => new Date('2026-09-05T00:00:00.000Z'),
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    randomSecret: () => 'a'.repeat(43),
  });
  return { coordinator, calls, values };
}

describe('durable account deletion coordinator', () => {
  test('persists the recovery receipt before the first remote request and reuses it', async () => {
    const f = fixture({ startFails: true });

    await expect(f.coordinator.begin('user-1')).rejects.toThrow(/response lost/i);
    const saved = await f.coordinator.read();
    expect(saved).toMatchObject({
      ownerId: 'user-1',
      requestId: '11111111-1111-4111-8111-111111111111',
      receiptSecret: 'a'.repeat(43),
      stage: 'created',
    });

    await expect(f.coordinator.begin('user-1')).rejects.toThrow(/response lost/i);
    const starts = f.calls.filter(([name]) => name === 'start');
    expect(starts).toHaveLength(2);
    expect(starts[0]?.[1]).toEqual(starts[1]?.[1]);
  });

  test('keeps a failed deletion retryable without clearing local recovery state', async () => {
    const f = fixture({ deleteFails: true });
    await f.coordinator.begin('user-1');

    await expect(f.coordinator.execute({
      ownerId: 'user-1',
      reauthenticationToken: 'fresh-access-token',
      googleProviderToken: 'short-lived-provider-token',
    })).rejects.toThrow(/offline/i);

    await expect(f.coordinator.read()).resolves.toMatchObject({
      ownerId: 'user-1',
      stage: 'challenged',
    });
    expect(f.calls.some(([name]) => name === 'remove')).toBe(false);
  });

  test('stores a completion receipt until local cleanup explicitly acknowledges it', async () => {
    const f = fixture();
    await f.coordinator.begin('user-1');

    await expect(f.coordinator.execute({
      ownerId: 'user-1',
      reauthenticationToken: 'fresh-access-token',
    })).resolves.toMatchObject({
      status: 'completed',
      manualRevocationRequired: true,
    });
    const receipt = await f.coordinator.read();
    expect(receipt?.stage).toBe('completed');

    await f.coordinator.acknowledgeCompleted(receipt!.requestId);
    await expect(f.coordinator.read()).resolves.toBeNull();
  });

  test('recovers completion through the public receipt endpoint after Auth is gone', async () => {
    const f = fixture({ status: 'completed' });
    await f.coordinator.begin('user-1');

    await expect(f.coordinator.recover()).resolves.toMatchObject({
      status: 'completed',
      manualRevocationRequired: true,
    });
    expect(f.calls).toContainEqual([
      'status',
      expect.objectContaining({ receiptSecret: 'a'.repeat(43) }),
    ]);
  });

  test('never reuses a receipt for a different account', async () => {
    const f = fixture();
    await f.coordinator.begin('user-1');

    await expect(f.coordinator.begin('user-2')).rejects.toThrow(/different account/i);
    expect(f.calls.filter(([name]) => name === 'start')).toHaveLength(1);
  });

  test('replaces an expired un-authorized challenge only after checking its server receipt', async () => {
    const f = fixture({ status: 'challenged' });
    f.values.set(ACCOUNT_DELETION_RECEIPT_KEY, JSON.stringify({
      version: 1,
      ownerId: 'user-1',
      requestId: '22222222-2222-4222-8222-222222222222',
      receiptSecret: 'b'.repeat(43),
      stage: 'challenged',
      createdAt: '2026-09-04T23:00:00.000Z',
      expiresAt: '2026-09-04T23:10:00.000Z',
      manualRevocationRequired: false,
    }));

    await f.coordinator.begin('user-1');

    expect(f.calls[0]).toEqual([
      'status',
      expect.objectContaining({ requestId: '22222222-2222-4222-8222-222222222222' }),
    ]);
    expect(f.calls.some(([name]) => name === 'remove')).toBe(true);
    expect(f.calls).toContainEqual([
      'start',
      expect.objectContaining({ requestId: '11111111-1111-4111-8111-111111111111' }),
    ]);
  });
});
