jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import { createMemoryCloudRepository } from '../../lib/account/cloudRepository';
import { snapshotFromCloudRows } from '../../lib/account/accountBootstrapPersistence';
import { mutationFixture } from './fixtures';

const NOW = '2026-09-05T00:00:00.000Z';

const tripPayload = (endDate = '2026-10-03') => ({
  id: 'trip-1',
  title: '北海道',
  startDate: '2026-10-01',
  endDate,
  color: '#2563EB',
  startIcon: 'plane',
  endIcon: 'plane',
  createdAt: NOW,
  updatedAt: NOW,
  revision: 1,
});

const itemPayload = (localDate = '2026-10-02') => ({
  id: 'item-1',
  tripId: 'trip-1',
  type: 'flight',
  localDate,
  allDay: false,
  sortOrder: 0,
});

function repositoryFixture() {
  return createMemoryCloudRepository([
    {
      ownerId: 'u1',
      entity: 'trip',
      id: 'trip-1',
      revision: 1,
      payload: tripPayload(),
      schemaVersion: 1,
      updatedAt: NOW,
    },
    {
      ownerId: 'u1',
      entity: 'trip-item',
      id: 'item-1',
      revision: 1,
      payload: itemPayload(),
      schemaVersion: 1,
      updatedAt: NOW,
    },
  ]);
}

describe('personal travel cloud graph integrity', () => {
  test('rejects a stale parent shrink after another device moves a child to the old boundary', async () => {
    const repository = repositoryFixture();

    await expect(repository.applyMutation(mutationFixture({
      mutationId: 'device-b-child',
      entity: 'trip-item',
      entityId: 'item-1',
      payload: itemPayload('2026-10-03'),
      baseRevision: 1,
    }))).resolves.toMatchObject({ status: 'applied' });

    await expect(repository.applyMutation(mutationFixture({
      mutationId: 'device-a-shrink',
      entity: 'trip',
      entityId: 'trip-1',
      payload: tripPayload('2026-10-02'),
      baseRevision: 1,
    }))).rejects.toMatchObject({ retryable: false });

    const remote = await repository.pull('u1');
    expect(snapshotFromCloudRows(remote.rows).trips).toEqual([
      expect.objectContaining({ id: 'trip-1', endDate: '2026-10-03' }),
    ]);
    expect(snapshotFromCloudRows(remote.rows).tripItems).toEqual([
      expect.objectContaining({ id: 'item-1', localDate: '2026-10-03' }),
    ]);
  });

  test('atomically tombstones children so a racing child update cannot resurrect an orphan', async () => {
    const repository = repositoryFixture();
    const beforeDelete = await repository.pull('u1');
    const appliedChildMutation = mutationFixture({
      mutationId: 'device-b-child-before-delete',
      entity: 'trip-item',
      entityId: 'item-1',
      payload: itemPayload('2026-10-02'),
      baseRevision: 1,
    });
    const appliedChildAck = await repository.applyMutation(appliedChildMutation);
    const parentDelete = mutationFixture({
      mutationId: 'device-a-delete',
      entity: 'trip',
      entityId: 'trip-1',
      operation: 'delete',
      payload: null,
      baseRevision: 1,
    });

    const first = await repository.applyMutation(parentDelete);
    const replay = await repository.applyMutation(parentDelete);
    expect(replay).toEqual(first);
    await expect(repository.applyMutation(appliedChildMutation)).resolves.toEqual(appliedChildAck);

    await expect(repository.applyMutation(mutationFixture({
      mutationId: 'device-b-child-after-delete',
      entity: 'trip-item',
      entityId: 'item-1',
      payload: itemPayload('2026-10-02'),
      baseRevision: 1,
    }))).resolves.toMatchObject({ status: 'conflict', deleted: true });

    const remote = await repository.pull('u1', beforeDelete.cursor);
    expect(remote.rows.filter((row) => row.entity === 'trip' || row.entity === 'trip-item'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ entity: 'trip', id: 'trip-1', payload: null }),
        expect.objectContaining({ entity: 'trip-item', id: 'item-1', payload: null }),
      ]));
    expect(snapshotFromCloudRows(remote.rows)).toMatchObject({ trips: [], tripItems: [] });
  });
});
