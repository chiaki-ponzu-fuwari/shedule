jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import type { AccountBootstrapPersistence } from '../../lib/account/accountBootstrap';
import {
  ACCOUNT_OUTBOX_DOMAIN,
  ACCOUNT_SYNC_STATE_DOMAIN,
  type AccountRuntimeSyncPersistence,
} from '../../lib/account/accountBootstrapPersistence';
import {
  createAccountOutboxProducerPersistence,
} from '../../lib/account/productionOutboxProducer';
import type { AccountRemotePublishGuard } from '../../lib/account/outboxProducer';
import {
  createOwnerStateStorage,
  createOwnerStorage,
  type KeyValueStorage,
} from '../../lib/account/namespacedStorage';
import type { OutboxMutation } from '../../types/account';

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
}

const mutation: OutboxMutation = {
  mutationId: '00000000-0000-4000-8000-000000000001',
  ownerId: 'user-a',
  entity: 'calendar-entry',
  entityId: '2026-09-05',
  operation: 'upsert',
  payload: { date: '2026-09-05', miniStamps: {}, privacyLevel: 2 },
  baseRevision: 1,
  createdAt: '2026-09-05T12:00:00.000Z',
  attempts: 0,
  schemaVersion: 1,
};

function bootstrapPersistenceFixture() {
  return {
    commitMigration: jest.fn(async () => undefined),
    commitRuntimeSync: jest.fn(async () => true),
  } as unknown as AccountBootstrapPersistence & AccountRuntimeSyncPersistence;
}

describe('production outbox persistence', () => {
  test('reads bootstrap sync metadata and durably round-trips the selected owner outbox', async () => {
    const storage = new MemoryStorage();
    const ownerStorage = createOwnerStorage(storage, { randomUUID: () => 'install-1' });
    await ownerStorage.getOwner();
    await ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
    const ownerState = createOwnerStateStorage(ownerStorage, {});
    await ownerState.setItem(ACCOUNT_SYNC_STATE_DOMAIN, JSON.stringify({
      version: 1,
      ownerId: 'user-a',
      rows: [],
      cursor: 'cursor-1',
      lastSyncedAt: '2026-09-05T12:00:00.000Z',
      migrationComplete: true,
      syncPhase: 'synced',
    }));
    const persistence = createAccountOutboxProducerPersistence({
      storage,
      ownerStorage,
      bootstrapPersistence: bootstrapPersistenceFixture(),
    });

    await expect(persistence.readSyncState('user-a')).resolves.toMatchObject({
      cursor: 'cursor-1',
      rows: [],
    });
    await persistence.commitOutbox('user-a', [mutation]);

    await expect(persistence.readOutbox('user-a')).resolves.toEqual([mutation]);
    expect(JSON.parse((await ownerState.getItem(ACCOUNT_OUTBOX_DOMAIN))!)).toEqual([mutation]);
  });

  test('refuses every read or write after the selected owner changes', async () => {
    const storage = new MemoryStorage();
    const ownerStorage = createOwnerStorage(storage, { randomUUID: () => 'install-1' });
    await ownerStorage.getOwner();
    await ownerStorage.switchOwner({ kind: 'user', id: 'user-b' });
    const persistence = createAccountOutboxProducerPersistence({
      storage,
      ownerStorage,
      bootstrapPersistence: bootstrapPersistenceFixture(),
    });

    await expect(persistence.readOutbox('user-a')).rejects.toThrow('active owner');
    await expect(persistence.commitOutbox('user-a', [mutation])).rejects.toThrow('active owner');
  });

  test('rejects a malformed durable mutation id', async () => {
    const storage = new MemoryStorage();
    const ownerStorage = createOwnerStorage(storage, { randomUUID: () => 'install-1' });
    await ownerStorage.getOwner();
    await ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
    const persistence = createAccountOutboxProducerPersistence({
      storage,
      ownerStorage,
      bootstrapPersistence: bootstrapPersistenceFixture(),
    });

    await expect(persistence.commitOutbox('user-a', [{
      ...mutation,
      mutationId: 'Date.now()',
    }])).rejects.toThrow('mutation');
  });

  test('commits the pulled rows through the existing crash-recovery journal', async () => {
    const storage = new MemoryStorage();
    const ownerStorage = createOwnerStorage(storage, { randomUUID: () => 'install-1' });
    await ownerStorage.getOwner();
    await ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
    const bootstrap = bootstrapPersistenceFixture();
    const persistence = createAccountOutboxProducerPersistence({
      storage,
      ownerStorage,
      bootstrapPersistence: bootstrap,
    });
    const row = {
      ownerId: 'user-a',
      entity: 'calendar-entry' as const,
      id: '2026-09-05',
      revision: 2,
      payload: mutation.payload,
      updatedAt: '2026-09-05T12:01:00.000Z',
      schemaVersion: 1,
    };

    const publishCalls = jest.fn();
    const guard: AccountRemotePublishGuard = {
      isCurrent: jest.fn(() => true),
      canPublish: jest.fn(() => true),
      runWhilePublishing<T>(publish: () => T) {
        publishCalls();
        return publish();
      },
    };
    await persistence.commitRemoteState(
      'user-a',
      { rows: [row], cursor: 'cursor-2', lastSyncedAt: '2026-09-05T12:01:00.000Z' },
      {
        entries: {},
        specialDates: [],
        preferences: {},
        stamps: [],
        trips: [],
        tripItems: [],
      },
      guard,
    );

    expect(bootstrap.commitRuntimeSync).toHaveBeenCalledWith('user-a', {
      rows: [row],
      cursor: 'cursor-2',
      conflictBackups: [],
      migrationComplete: true,
      syncPhase: 'synced',
    }, expect.any(Object), guard);
  });
});
