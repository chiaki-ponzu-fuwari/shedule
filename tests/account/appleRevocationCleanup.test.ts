import {
  APPLE_REVOCATION_CLEANUP_MARKER_KEY,
  createAppleRevocationCleanupCoordinator,
  type AppleRevocationCleanupStorage,
} from '../../lib/account/appleRevocationCleanup';

function storageFixture(initial?: string): AppleRevocationCleanupStorage & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(APPLE_REVOCATION_CLEANUP_MARKER_KEY, initial);
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async (key) => { values.delete(key); },
  };
}

describe('durable Apple revocation local cleanup', () => {
  test('persists and verifies an owner-bound marker before clearing local user data', async () => {
    const storage = storageFixture();
    const order: string[] = [];
    const setItem = storage.setItem.bind(storage);
    storage.setItem = async (key, value) => {
      await setItem(key, value);
      order.push('marker');
    };
    const cleanup = jest.fn(async (ownerId: string) => {
      expect(ownerId).toBe('user-apple');
      expect(storage.values.has(APPLE_REVOCATION_CLEANUP_MARKER_KEY)).toBe(true);
      order.push('cleanup');
      return { complete: true, errors: [] };
    });
    const coordinator = createAppleRevocationCleanupCoordinator({
      storage,
      cleanup,
      now: () => new Date('2026-09-05T01:02:03.000Z'),
    });

    await expect(coordinator.begin('user-apple')).resolves.toEqual({
      status: 'cleared',
      ownerId: 'user-apple',
    });

    expect(order).toEqual(['marker', 'cleanup']);
    expect(storage.values.has(APPLE_REVOCATION_CLEANUP_MARKER_KEY)).toBe(false);
  });

  test('keeps the marker when any cleanup surface is incomplete and retries it on startup', async () => {
    const storage = storageFixture();
    const cleanup = jest
      .fn()
      .mockResolvedValueOnce({ complete: false, errors: ['private path / secret'] })
      .mockResolvedValueOnce({ complete: true, errors: [] });
    const coordinator = createAppleRevocationCleanupCoordinator({ storage, cleanup });

    await expect(coordinator.begin('user-apple')).resolves.toEqual({
      status: 'pending',
      ownerId: 'user-apple',
    });
    expect(storage.values.has(APPLE_REVOCATION_CLEANUP_MARKER_KEY)).toBe(true);

    await expect(coordinator.recover()).resolves.toEqual({
      status: 'cleared',
      ownerId: 'user-apple',
    });
    expect(cleanup).toHaveBeenNthCalledWith(1, 'user-apple');
    expect(cleanup).toHaveBeenNthCalledWith(2, 'user-apple');
    expect(storage.values.has(APPLE_REVOCATION_CLEANUP_MARKER_KEY)).toBe(false);
  });

  test('never overwrites a pending marker belonging to another verified uid', async () => {
    const storage = storageFixture(JSON.stringify({
      version: 1,
      ownerId: 'user-original',
      createdAt: '2026-09-05T01:02:03.000Z',
    }));
    const cleanup = jest.fn(async () => ({ complete: true, errors: [] }));
    const coordinator = createAppleRevocationCleanupCoordinator({ storage, cleanup });

    await expect(coordinator.begin('user-attacker')).rejects.toThrow('different account');
    expect(cleanup).not.toHaveBeenCalled();
    expect(JSON.parse(storage.values.get(APPLE_REVOCATION_CLEANUP_MARKER_KEY)!)).toEqual(
      expect.objectContaining({ ownerId: 'user-original' }),
    );
  });

  test('returns none when there is no interrupted cleanup to recover', async () => {
    const cleanup = jest.fn(async () => ({ complete: true, errors: [] }));
    const coordinator = createAppleRevocationCleanupCoordinator({
      storage: storageFixture(),
      cleanup,
    });

    await expect(coordinator.recover()).resolves.toEqual({ status: 'none' });
    expect(cleanup).not.toHaveBeenCalled();
  });
});
