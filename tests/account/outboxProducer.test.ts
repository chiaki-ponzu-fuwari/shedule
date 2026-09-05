jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import type { CloudRepository, CloudRow } from '../../lib/account/cloudRepository';
import {
  createAccountOutboxProducer,
  diffSnapshotRowsToOutbox,
  findPendingPersonalMediaReferences,
  type AccountOutboxProducerPersistence,
} from '../../lib/account/outboxProducer';
import type { DataOwner, OwnerStorage } from '../../lib/account/namespacedStorage';
import type { OutboxMutation, PersonalSnapshot } from '../../types/account';
import { emptyPersonalSnapshot } from './fixtures';

const NOW = '2026-09-05T12:00:00.000Z';
const uuid = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

function calendarRow(note: string, revision = 1): CloudRow {
  return {
    ownerId: 'user-a',
    entity: 'calendar-entry',
    id: '2026-09-05',
    revision,
    payload: {
      date: '2026-09-05',
      miniStamps: {},
      privacyLevel: 2,
      notes: note,
    },
    updatedAt: NOW,
    schemaVersion: 1,
  };
}

function snapshot(note: string | null): PersonalSnapshot {
  return {
    ...emptyPersonalSnapshot(),
    entries: note === null
      ? {}
      : {
          '2026-09-05': {
            date: '2026-09-05',
            miniStamps: {},
            privacyLevel: 2,
            notes: note,
          },
        },
    preferences: { weekStartDay: 1, locale: 'ja' },
    stamps: [],
  };
}

describe('outbox diff', () => {
  test('exposes device-only media as an explicit upload boundary without treating icons as files', () => {
    const value = snapshot('media');
    value.entries['2026-09-05'].imageUri = 'file:///private/calendar.png';
    value.entries['2026-09-05'].diaryPhotos = [
      'content://photos/diary-one',
      'user-a/diary/already-uploaded.jpg',
    ];
    value.stamps = [
      { id: 'photo', text: '', bgColor: '#fff', textColor: '#000', imageUri: 'blob:web-photo' },
      { id: 'inline', text: '', bgColor: '#fff', textColor: '#000', imageUri: 'data:image/png;base64,AAAA' },
      { id: 'icon', text: '', bgColor: '#fff', textColor: '#000', imageUri: 'icon://airplane' },
    ];

    expect(findPendingPersonalMediaReferences(value)).toEqual([
      {
        entity: 'calendar-entry',
        entityId: '2026-09-05',
        domain: 'calendar',
        sourceUris: ['file:///private/calendar.png'],
      },
      {
        entity: 'calendar-entry',
        entityId: '2026-09-05',
        domain: 'diary',
        sourceUris: ['content://photos/diary-one'],
      },
      {
        entity: 'stamp',
        entityId: 'photo',
        domain: 'stamp',
        sourceUris: ['blob:web-photo'],
      },
      {
        entity: 'stamp',
        entityId: 'inline',
        domain: 'stamp',
        sourceUris: ['data:image/png;base64,AAAA'],
      },
    ]);
  });

  test('creates CAS upserts and tombstones for managed local entities', () => {
    const mutations = diffSnapshotRowsToOutbox({
      ownerId: 'user-a',
      baselineRows: [
        calendarRow('before', 4),
        {
          ownerId: 'user-a',
          entity: 'special-date',
          id: 'old-birthday',
          revision: 7,
          payload: {
            id: 'old-birthday',
            name: '削除対象',
            month: 1,
            day: 2,
            color: '#f00',
            type: 'birthday',
          },
          updatedAt: NOW,
          schemaVersion: 1,
        },
      ],
      pending: [],
      localRows: [
        { ...calendarRow('after', 4), ownerId: undefined },
      ],
      now: NOW,
      randomUUID: (() => {
        let index = 0;
        return () => uuid(++index);
      })(),
    });

    expect(mutations).toEqual([
      expect.objectContaining({
        mutationId: uuid(1),
        entity: 'calendar-entry',
        entityId: '2026-09-05',
        operation: 'upsert',
        baseRevision: 4,
        schemaVersion: 1,
        payload: expect.objectContaining({ notes: 'after' }),
      }),
      expect.objectContaining({
        mutationId: uuid(2),
        entity: 'special-date',
        entityId: 'old-birthday',
        operation: 'delete',
        baseRevision: 7,
        schemaVersion: 1,
        payload: null,
      }),
    ]);
  });

  test('rejects a non-UUID mutation identifier before it can enter durable storage', () => {
    expect(() => diffSnapshotRowsToOutbox({
      ownerId: 'user-a',
      baselineRows: [calendarRow('before')],
      pending: [],
      localRows: [{ ...calendarRow('after'), ownerId: undefined }],
      now: NOW,
      randomUUID: () => 'timestamp-style-id',
    })).toThrow('UUID');
  });

  test('does not turn absent trip storage into destructive trip tombstones', () => {
    const mutations = diffSnapshotRowsToOutbox({
      ownerId: 'user-a',
      baselineRows: [{
        ownerId: 'user-a',
        entity: 'trip',
        id: 'remote-trip',
        revision: 3,
        payload: {
          title: '北海道',
          startDate: '2026-10-01',
          endDate: '2026-10-03',
          color: '#00f',
          startIcon: 'plane',
          endIcon: 'plane',
          createdAt: NOW,
          updatedAt: NOW,
          revision: 3,
        },
        updatedAt: NOW,
        schemaVersion: 1,
      }],
      pending: [],
      localRows: [],
      now: NOW,
      randomUUID: () => 'must-not-be-used',
    });

    expect(mutations).toEqual([]);
  });

  test('queues child tombstones before their parent trip tombstone', () => {
    const parent = {
      ownerId: 'user-a',
      entity: 'trip' as const,
      id: 'trip-1',
      revision: 3,
      payload: {
        id: 'trip-1',
        title: '北海道',
        startDate: '2026-10-01',
        endDate: '2026-10-03',
        color: '#2563EB',
        startIcon: 'plane',
        endIcon: 'plane',
        createdAt: NOW,
        updatedAt: NOW,
        revision: 3,
      },
      updatedAt: NOW,
      schemaVersion: 1,
    } satisfies CloudRow;
    const child = {
      ownerId: 'user-a',
      entity: 'trip-item' as const,
      id: 'item-1',
      revision: 4,
      payload: {
        id: 'item-1',
        tripId: 'trip-1',
        type: 'flight',
        localDate: '2026-10-02',
        allDay: false,
        sortOrder: 0,
      },
      updatedAt: NOW,
      schemaVersion: 1,
    } satisfies CloudRow;

    let index = 0;
    const mutations = diffSnapshotRowsToOutbox({
      ownerId: 'user-a',
      baselineRows: [parent, child],
      pending: [],
      localRows: [],
      managedEntities: ['trip', 'trip-item'],
      now: NOW,
      randomUUID: () => uuid(++index),
    });

    expect(mutations.map(({ entity, operation }) => [entity, operation])).toEqual([
      ['trip-item', 'delete'],
      ['trip', 'delete'],
    ]);
  });

  test('projects an already-durable mutation so restart reconciliation does not duplicate it', () => {
    const pending: OutboxMutation[] = [{
      mutationId: 'durable-one',
      ownerId: 'user-a',
      entity: 'calendar-entry',
      entityId: '2026-09-05',
      operation: 'upsert',
      payload: calendarRow('after').payload,
      baseRevision: 1,
      createdAt: NOW,
      attempts: 1,
      schemaVersion: 1,
    }];

    expect(diffSnapshotRowsToOutbox({
      ownerId: 'user-a',
      baselineRows: [calendarRow('before')],
      pending,
      localRows: [{ ...calendarRow('after'), ownerId: undefined }],
      now: NOW,
      randomUUID: () => 'duplicate',
    })).toEqual([]);
  });

  test('appends a tombstone when a not-yet-created pending row is deleted locally', () => {
    const pending: OutboxMutation[] = [{
      mutationId: '11111111-1111-4111-8111-111111111111',
      ownerId: 'user-a',
      entity: 'calendar-entry',
      entityId: '2026-09-06',
      operation: 'upsert',
      payload: {
        date: '2026-09-06',
        miniStamps: {},
        privacyLevel: 2,
      },
      baseRevision: null,
      createdAt: NOW,
      attempts: 0,
      schemaVersion: 1,
    }];

    expect(diffSnapshotRowsToOutbox({
      ownerId: 'user-a',
      baselineRows: [],
      pending,
      localRows: [],
      now: NOW,
      randomUUID: () => '22222222-2222-4222-8222-222222222222',
    })).toEqual([
      expect.objectContaining({
        mutationId: '22222222-2222-4222-8222-222222222222',
        entityId: '2026-09-06',
        operation: 'delete',
        baseRevision: null,
      }),
    ]);
  });

  test('does not mutate a row held behind the personal-media upload boundary', () => {
    expect(diffSnapshotRowsToOutbox({
      ownerId: 'user-a',
      baselineRows: [calendarRow('cloud-image')],
      pending: [],
      localRows: [{
        ...calendarRow('changed-with-local-image'),
        ownerId: undefined,
        payload: {
          ...calendarRow('changed-with-local-image').payload,
          imageUri: 'file:///private/new-image.jpg',
        },
      }],
      heldRows: [{
        entity: 'calendar-entry',
        entityId: '2026-09-05',
        domain: 'calendar',
        sourceUris: ['file:///private/new-image.jpg'],
      }],
      now: NOW,
      randomUUID: () => 'must-not-be-used',
    })).toEqual([]);
  });
});

function ownerStorageFixture(): OwnerStorage & { setOwner(owner: DataOwner): void } {
  let owner: DataOwner = { kind: 'user', id: 'user-a' };
  return {
    getOwner: async () => owner,
    switchOwner: async (next) => { owner = next; },
    key: (domain) => `test:${owner.kind}:${owner.id}:${domain}`,
    migrateLegacy: async () => ({ migrated: false }),
    setOwner: (next) => { owner = next; },
  };
}

function persistenceFixture(
  baselineRows: CloudRow[],
  events: string[],
): AccountOutboxProducerPersistence & { outbox: OutboxMutation[] } {
  const rows = [
    ...baselineRows,
    ...baselineRows.some((row) => row.entity === 'preference')
      ? []
      : [{
          ownerId: 'user-a',
          entity: 'preference' as const,
          id: 'preferences',
          revision: 1,
          payload: { weekStartDay: 1, locale: 'ja' },
          updatedAt: NOW,
          schemaVersion: 1,
        }],
  ];
  return {
    outbox: [],
    readSyncState: async () => ({
      rows: rows.map((row) => ({ ...row })),
      cursor: 'cursor-1',
      lastSyncedAt: NOW,
    }),
    readOutbox: async () => [],
    commitOutbox: async function (_ownerId, mutations) {
      events.push(`persist:${mutations.length}`);
      this.outbox = mutations.map((mutation) => ({ ...mutation }));
    },
    persistConflictBackups: async () => undefined,
    commitRemoteState: jest.fn(async () => {
      events.push('commit-remote');
      return true;
    }),
  };
}

describe('production outbox producer safety boundary', () => {
  test('reports a missing durable migration baseline as an error state', async () => {
    const owners = ownerStorageFixture();
    const persistence = persistenceFixture([], []);
    persistence.readSyncState = async () => null;
    const onResult = jest.fn();
    const producer = createAccountOutboxProducer({
      ownerId: 'user-a',
      ownerStorage: owners,
      persistence,
      repository: {
        pull: async () => ({ rows: [], cursor: 'unused' }),
        getMutationReceipts: async () => [],
        applyMutation: async () => { throw new Error('unused'); },
        verify: async () => ({ verified: true, failures: [] }),
      },
      readSnapshot: () => snapshot(null),
      now: () => new Date(NOW),
      randomUUID: () => uuid(1),
      onResult,
    });

    const result = await producer.reconcileAndFlush();

    expect(result).toMatchObject({ status: 'completed', syncPhase: 'error' });
    expect(onResult).toHaveBeenCalledWith(result);
  });

  test('persists the mutation before the first remote request and checks the selected owner again', async () => {
    const events: string[] = [];
    const owners = ownerStorageFixture();
    const persistence = persistenceFixture([calendarRow('before')], events);
    const repository: CloudRepository = {
      pull: async () => {
        events.push('remote:pull');
        return { rows: [calendarRow('after', 2)], cursor: 'cursor-2' };
      },
      getMutationReceipts: async () => [],
      applyMutation: async (mutation) => {
        events.push('remote:apply');
        return {
          mutationId: mutation.mutationId,
          ownerId: mutation.ownerId,
          entity: mutation.entity,
          entityId: mutation.entityId,
          status: 'applied',
          revision: 2,
          deleted: false,
          row: calendarRow('after', 2),
          schemaVersion: 1,
        };
      },
      verify: async () => ({ verified: true, failures: [] }),
    };
    const producer = createAccountOutboxProducer({
      ownerId: 'user-a',
      ownerStorage: owners,
      persistence,
      repository,
      readSnapshot: () => snapshot('after'),
      now: () => new Date(NOW),
      randomUUID: () => uuid(1),
    });

    await producer.reconcileAndFlush();

    expect(events.indexOf('persist:1')).toBeLessThan(events.indexOf('remote:apply'));
    expect(events).toContain('persist:0');
    expect(events).toContain('commit-remote');
  });

  test('keeps an offline mutation durable and a new producer flushes the same id after restart', async () => {
    const events: string[] = [];
    const owners = ownerStorageFixture();
    const persistence = persistenceFixture([calendarRow('before')], events);
    persistence.readOutbox = async () => persistence.outbox.map((mutation) => ({ ...mutation }));
    const offlineRepository: CloudRepository = {
      pull: async () => { throw new Error('offline'); },
      getMutationReceipts: async () => { throw new Error('offline'); },
      applyMutation: async () => { throw new Error('offline'); },
      verify: async () => { throw new Error('offline'); },
    };
    const first = createAccountOutboxProducer({
      ownerId: 'user-a',
      ownerStorage: owners,
      persistence,
      repository: offlineRepository,
      readSnapshot: () => snapshot('after'),
      now: () => new Date(NOW),
      randomUUID: () => uuid(1),
    });

    const offlineResult = await first.reconcileAndFlush();
    expect(offlineResult).toMatchObject({
      syncPhase: 'pending',
      retryDelayMs: expect.any(Number),
    });
    if (offlineResult.status === 'completed') {
      expect(offlineResult.retryDelayMs).toBeGreaterThan(0);
    }
    expect(persistence.outbox).toEqual([
      expect.objectContaining({ mutationId: uuid(1), attempts: 1 }),
    ]);

    const seenIds: string[] = [];
    const onlineRepository: CloudRepository = {
      pull: async () => ({ rows: [calendarRow('after', 2)], cursor: 'cursor-2' }),
      getMutationReceipts: async () => [],
      applyMutation: async (mutation) => {
        seenIds.push(mutation.mutationId);
        return {
          mutationId: mutation.mutationId,
          ownerId: mutation.ownerId,
          entity: mutation.entity,
          entityId: mutation.entityId,
          status: 'applied',
          revision: 2,
          deleted: false,
          row: calendarRow('after', 2),
          schemaVersion: 1,
        };
      },
      verify: async () => ({ verified: true, failures: [] }),
    };
    const restarted = createAccountOutboxProducer({
      ownerId: 'user-a',
      ownerStorage: owners,
      persistence,
      repository: onlineRepository,
      readSnapshot: () => snapshot('after'),
      now: () => new Date(NOW),
      randomUUID: () => uuid(2),
    });

    await restarted.reconcileAndFlush();

    expect(seenIds).toEqual([uuid(1)]);
    expect(persistence.outbox).toEqual([]);
  });

  test('invalidates an in-flight generation before another owner can receive a remote commit', async () => {
    let resolvePull!: (value: { rows: CloudRow[]; cursor: string }) => void;
    const delayedPull = new Promise<{ rows: CloudRow[]; cursor: string }>((resolve) => {
      resolvePull = resolve;
    });
    const owners = ownerStorageFixture();
    const persistence = persistenceFixture([calendarRow('same')], []);
    const repository: CloudRepository = {
      pull: async () => delayedPull,
      getMutationReceipts: async () => [],
      applyMutation: async () => { throw new Error('not expected'); },
      verify: async () => ({ verified: true, failures: [] }),
    };
    const producer = createAccountOutboxProducer({
      ownerId: 'user-a',
      ownerStorage: owners,
      persistence,
      repository,
      readSnapshot: () => snapshot('same'),
      now: () => new Date(NOW),
      randomUUID: () => 'unused',
    });

    const pending = producer.reconcileAndFlush();
    await Promise.resolve();
    owners.setOwner({ kind: 'user', id: 'user-b' });
    producer.invalidate();
    resolvePull({ rows: [calendarRow('same')], cursor: 'cursor-2' });

    await expect(pending).resolves.toMatchObject({ status: 'superseded' });
    expect(persistence.commitRemoteState).not.toHaveBeenCalled();
  });

  test('journals a newer local edit before a remote refresh can replace visible state', async () => {
    let resolvePull!: (value: { rows: CloudRow[]; cursor: string }) => void;
    const delayedPull = new Promise<{ rows: CloudRow[]; cursor: string }>((resolve) => {
      resolvePull = resolve;
    });
    const owners = ownerStorageFixture();
    const persistence = persistenceFixture([calendarRow('before')], []);
    persistence.readOutbox = async () => persistence.outbox.map((mutation) => ({ ...mutation }));
    let local = snapshot('after');
    let uuid = 0;
    const repository: CloudRepository = {
      pull: async () => delayedPull,
      getMutationReceipts: async () => [],
      applyMutation: async (mutation) => ({
        mutationId: mutation.mutationId,
        ownerId: mutation.ownerId,
        entity: mutation.entity,
        entityId: mutation.entityId,
        status: 'applied',
        revision: 2,
        deleted: false,
        row: calendarRow('after', 2),
        schemaVersion: 1,
      }),
      verify: async () => ({ verified: true, failures: [] }),
    };
    const producer = createAccountOutboxProducer({
      ownerId: 'user-a',
      ownerStorage: owners,
      persistence,
      repository,
      readSnapshot: () => local,
      now: () => new Date(NOW),
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    });

    const pending = producer.reconcileAndFlush();
    while (!persistence.outbox.some((mutation) => mutation.mutationId === '00000000-0000-4000-8000-000000000001')) {
      await Promise.resolve();
    }
    local = snapshot('newer-while-syncing');
    resolvePull({
      rows: [
        calendarRow('after', 2),
        {
          ownerId: 'user-a',
          entity: 'special-date',
          id: 'remote-anniversary',
          revision: 1,
          payload: {
            id: 'remote-anniversary',
            name: '記念日',
            month: 9,
            day: 5,
            color: '#f00',
            type: 'anniversary',
          },
          updatedAt: NOW,
          schemaVersion: 1,
        },
        {
          ownerId: 'user-a',
          entity: 'preference',
          id: 'preferences',
          revision: 1,
          payload: { weekStartDay: 1, locale: 'ja' },
          updatedAt: NOW,
          schemaVersion: 1,
        },
      ],
      cursor: 'cursor-2',
    });

    await expect(pending).resolves.toMatchObject({
      syncPhase: 'pending',
      followUpRequired: true,
    });
    expect(persistence.outbox).toEqual([
      expect.objectContaining({
        mutationId: '00000000-0000-4000-8000-000000000002',
        baseRevision: 2,
        payload: expect.objectContaining({ notes: 'newer-while-syncing' }),
      }),
    ]);
    expect(persistence.commitRemoteState).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({ cursor: 'cursor-2' }),
      expect.objectContaining({
        entries: {
          '2026-09-05': expect.objectContaining({ notes: 'newer-while-syncing' }),
        },
        specialDates: [expect.objectContaining({ id: 'remote-anniversary' })],
      }),
      expect.any(Object),
    );
  });

  test('defers a media-bearing row and never publishes a remote snapshot over its device URI', async () => {
    const owners = ownerStorageFixture();
    const events: string[] = [];
    const persistence = persistenceFixture([calendarRow('before')], events);
    const applyMutation = jest.fn();
    const pull = jest.fn();
    const producer = createAccountOutboxProducer({
      ownerId: 'user-a',
      ownerStorage: owners,
      persistence,
      repository: {
        pull,
        getMutationReceipts: async () => [],
        applyMutation,
        verify: async () => ({ verified: true, failures: [] }),
      },
      readSnapshot: () => snapshot('changed-with-image'),
      readPendingMedia: () => [{
        entity: 'calendar-entry',
        entityId: '2026-09-05',
        domain: 'calendar',
        sourceUris: ['file:///private/new-image.jpg'],
      }],
      now: () => new Date(NOW),
      randomUUID: () => 'must-not-be-used',
    });

    await expect(producer.reconcileAndFlush()).resolves.toMatchObject({
      syncPhase: 'pending',
      mediaPending: true,
    });
    expect(applyMutation).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(persistence.commitRemoteState).not.toHaveBeenCalled();
  });

  test('keeps unrelated edits durable but does not flush them until media-held rows can reconcile too', async () => {
    const owners = ownerStorageFixture();
    const persistence = persistenceFixture([calendarRow('before')], []);
    const applyMutation = jest.fn(async (mutation: OutboxMutation) => ({
      mutationId: mutation.mutationId,
      ownerId: mutation.ownerId,
      entity: mutation.entity,
      entityId: mutation.entityId,
      status: 'applied' as const,
      revision: 2,
      deleted: false,
      row: {
        ownerId: mutation.ownerId,
        entity: mutation.entity,
        id: mutation.entityId,
        revision: 2,
        payload: mutation.payload,
        updatedAt: NOW,
        schemaVersion: 1,
      },
      schemaVersion: 1,
    }));
    const local = snapshot('changed-with-image');
    local.preferences.locale = 'en';
    const producer = createAccountOutboxProducer({
      ownerId: 'user-a',
      ownerStorage: owners,
      persistence,
      repository: {
        pull: jest.fn(async () => ({ rows: [], cursor: 'unused' })),
        getMutationReceipts: async () => [],
        applyMutation,
        verify: async () => ({ verified: true, failures: [] }),
      },
      readSnapshot: () => local,
      readPendingMedia: () => [{
        entity: 'calendar-entry',
        entityId: '2026-09-05',
        domain: 'calendar',
        sourceUris: ['file:///private/new-image.jpg'],
      }],
      now: () => new Date(NOW),
      randomUUID: () => uuid(1),
    });

    await expect(producer.reconcileAndFlush()).resolves.toMatchObject({
      syncPhase: 'pending',
      enqueued: 1,
      mediaPending: true,
    });
    expect(persistence.outbox).toEqual([
      expect.objectContaining({ entity: 'preference', operation: 'upsert' }),
    ]);
    expect(applyMutation).not.toHaveBeenCalled();
  });

  test('aborts remote publication when a local store changes during its durable commit', async () => {
    const owners = ownerStorageFixture();
    const persistence = persistenceFixture([calendarRow('same')], []);
    let producer!: ReturnType<typeof createAccountOutboxProducer>;
    persistence.commitRemoteState = jest.fn(async (_ownerId, _state, _snapshot, guard) => {
      producer.noteLocalChange();
      expect(guard.canPublish()).toBe(false);
      return false;
    });
    producer = createAccountOutboxProducer({
      ownerId: 'user-a',
      ownerStorage: owners,
      persistence,
      repository: {
        pull: async () => ({
          rows: [
            calendarRow('same'),
            {
              ownerId: 'user-a',
              entity: 'preference',
              id: 'preferences',
              revision: 1,
              payload: { weekStartDay: 1, locale: 'ja' },
              updatedAt: NOW,
              schemaVersion: 1,
            },
          ],
          cursor: 'cursor-2',
        }),
        getMutationReceipts: async () => [],
        applyMutation: async () => { throw new Error('not expected'); },
        verify: async () => ({ verified: true, failures: [] }),
      },
      readSnapshot: () => snapshot('same'),
      now: () => new Date(NOW),
      randomUUID: () => uuid(1),
    });

    await expect(producer.reconcileAndFlush()).resolves.toMatchObject({
      syncPhase: 'pending',
      followUpRequired: true,
    });
  });
});
