jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-crypto', () => ({
  randomUUID: () => '99999999-9999-4999-8999-999999999999',
}));

import {
  PERSONAL_MEDIA_SYNC_DOMAIN,
  createPersonalMediaCleanupQueue,
  createPersonalMediaReadUrlResolver,
  createPersonalMediaSyncPersistence,
} from '../../lib/account/productionPersonalMedia';
import { createOwnerStorage, type KeyValueStorage } from '../../lib/account/namespacedStorage';
import {
  createMediaAwareCloudSyncProducer,
  createProductionPersonalMediaLocalAdapter,
} from '../../lib/account/productionPersonalMediaRuntime';
import type { PersonalMediaSyncState } from '../../lib/account/personalMediaSync';
import { useCalendarStore } from '../../store/calendarStore';

const OWNER = 'user-a';
const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const KEY = `${OWNER}/diary/${MEDIA_ID}.jpg`;

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
}

function state(): PersonalMediaSyncState {
  return {
    version: 1,
    uploads: [{
      target: {
        entity: 'calendar-entry',
        entityId: '2026-09-05',
        domain: 'diary',
        field: 'diaryPhotos',
        index: 0,
      },
      sourceUri: 'content://picker/photo',
      phase: 'prepared',
      pending: {
        mutationId: MEDIA_ID,
        ownerId: OWNER,
        domain: 'diary',
        objectKey: KEY,
        stagedUri: `file:///documents/recoto-media-outbox/${MEDIA_ID}.jpg`,
        attempts: 0,
      },
    }],
    cleanups: [],
    stagedCleanups: [],
  };
}

describe('production personal media adapters', () => {
  test('still durably reconciles the ordinary outbox when media preparation fails', async () => {
    const mediaError = new Error('JPEG processing failed');
    const media = {
      reconcile: jest.fn(async () => { throw mediaError; }),
      invalidate: jest.fn(),
      whenIdle: jest.fn(async () => undefined),
    };
    const cloud = {
      reconcileAndFlush: jest.fn(async () => ({ status: 'held-durably' })),
      isApplyingRemote: jest.fn(() => false),
      noteLocalChange: jest.fn(),
      invalidate: jest.fn(),
    };
    const producer = createMediaAwareCloudSyncProducer({
      media: media as never,
      cloud,
    });

    await expect(producer.reconcileAndFlush()).rejects.toBe(mediaError);
    expect(cloud.reconcileAndFlush).toHaveBeenCalledTimes(1);
  });

  test('durably round-trips strict state in an explicit owner namespace', async () => {
    const storage = new MemoryStorage();
    const persistence = createPersonalMediaSyncPersistence({ storage });

    await persistence.write(OWNER, state());

    await expect(persistence.read(OWNER)).resolves.toEqual(state());
    expect(storage.values.has(`recoto:user:${OWNER}:${PERSONAL_MEDIA_SYNC_DOMAIN}`)).toBe(true);
    expect(storage.values.has(`recoto:user:user-b:${PERSONAL_MEDIA_SYNC_DOMAIN}`)).toBe(false);
  });

  test('rejects corrupt or cross-owner durable jobs instead of uploading them', async () => {
    const storage = new MemoryStorage();
    const persistence = createPersonalMediaSyncPersistence({ storage });
    const invalid = state();
    invalid.uploads[0].pending.ownerId = 'user-b';
    storage.values.set(
      `recoto:user:${OWNER}:${PERSONAL_MEDIA_SYNC_DOMAIN}`,
      JSON.stringify(invalid),
    );

    await expect(persistence.read(OWNER)).rejects.toThrow(/personal media sync state/i);
    await expect(persistence.write('bad:owner', state())).rejects.toThrow(/owner/i);

    const crossDomain = state();
    crossDomain.uploads[0].target.domain = 'calendar';
    await expect(persistence.write(OWNER, crossDomain)).rejects.toThrow(/personal media sync state/i);

    const forgedStagePath = state();
    forgedStagePath.uploads[0].pending.stagedUri =
      'file:///private/app/Documents/preferences.json';
    await expect(persistence.write(OWNER, forgedStagePath))
      .rejects.toThrow(/personal media sync state/i);
  });

  test('persists service cleanup callbacks without losing existing upload jobs', async () => {
    const storage = new MemoryStorage();
    const persistence = createPersonalMediaSyncPersistence({ storage });
    await persistence.write(OWNER, state());
    const cleanup = createPersonalMediaCleanupQueue({
      ownerId: OWNER,
      persistence,
      now: () => new Date('2026-09-05T12:00:00.000Z'),
    });

    await cleanup.enqueue(`${OWNER}/calendar/22222222-2222-4222-8222-222222222222.jpg`);
    const orphanStage = `file:///documents/recoto-media-outbox/${MEDIA_ID}.jpg`;
    await cleanup.enqueueStagedFile(orphanStage, MEDIA_ID);

    await expect(persistence.read(OWNER)).resolves.toMatchObject({
      uploads: state().uploads,
      cleanups: [{
        objectKey: `${OWNER}/calendar/22222222-2222-4222-8222-222222222222.jpg`,
        queuedAt: '2026-09-05T12:00:00.000Z',
      }],
      stagedCleanups: [{
        stagedUri: orphanStage,
        afterMutationId: MEDIA_ID,
      }],
    });

    await cleanup.complete(`${OWNER}/calendar/22222222-2222-4222-8222-222222222222.jpg`);
    await cleanup.completeStagedFile(orphanStage);
    await expect(persistence.read(OWNER)).resolves.toMatchObject({
      uploads: state().uploads,
      cleanups: [],
      stagedCleanups: [],
    });
  });

  test('resolves only the current owner object key and deduplicates short-lived signed URLs', async () => {
    let now = Date.parse('2026-09-05T12:00:00.000Z');
    const sign = jest.fn(async (ownerId: string, domain: 'diary', objectKey: string) =>
      `https://signed.example/${ownerId}/${domain}?key=${objectKey}`);
    const resolver = createPersonalMediaReadUrlResolver({
      ownerId: OWNER,
      createSignedReadUrl: sign,
      now: () => now,
    });

    await expect(resolver.resolve(KEY)).resolves.toBe(
      `https://signed.example/${OWNER}/diary?key=${KEY}`,
    );
    await expect(resolver.resolve(KEY)).resolves.toContain('https://signed.example/');
    expect(sign).toHaveBeenCalledTimes(1);
    await expect(resolver.resolve(`user-b/diary/${MEDIA_ID}.jpg`)).resolves.toBeUndefined();
    await expect(resolver.resolve(KEY, 'calendar')).resolves.toBeUndefined();
    expect(sign).toHaveBeenCalledTimes(1);
    const stampKey = `${OWNER}/stamp/55555555-5555-4555-8555-555555555555.jpg`;
    await expect(resolver.resolve(stampKey, ['calendar', 'stamp']))
      .resolves.toContain(stampKey);
    expect(sign).toHaveBeenCalledTimes(2);
    await expect(resolver.resolve('https://tracker.example/pixel.jpg')).resolves.toBeUndefined();
    await expect(resolver.resolve('file:///private/local.jpg')).resolves.toBe('file:///private/local.jpg');
    await expect(resolver.resolve('icon://heart')).resolves.toBe('icon://heart');

    now += 9 * 60 * 1000;
    await resolver.resolve(KEY);
    expect(sign).toHaveBeenCalledTimes(3);
  });

  test('deduplicates concurrent signing requests for the same key', async () => {
    let release!: (url: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const sign = jest.fn(() => pending);
    const resolver = createPersonalMediaReadUrlResolver({
      ownerId: OWNER,
      createSignedReadUrl: sign,
    });

    const first = resolver.resolve(KEY);
    const second = resolver.resolve(KEY);
    release('https://signed.example/media');

    await expect(Promise.all([first, second])).resolves.toEqual([
      'https://signed.example/media',
      'https://signed.example/media',
    ]);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  test('persists only the old owner patch when owner switching races durable local write', async () => {
    const storage = new MemoryStorage();
    const owners = createOwnerStorage(storage, { randomUUID: () => 'install-1' });
    await owners.getOwner();
    await owners.switchOwner({ kind: 'user', id: OWNER });
    useCalendarStore.getState().replaceState({
      entries: {
        '2026-09-05': {
          date: '2026-09-05', miniStamps: {}, privacyLevel: 2,
          imageUri: 'file:///private/old-owner.jpg',
        },
      },
      recurringSchedules: [],
      specialDates: [],
      weekStartDay: 1,
    });
    const originalSet = storage.setItem.bind(storage);
    let switched = false;
    storage.setItem = async (key, value) => {
      await originalSet(key, value);
      if (!switched && key === `recoto:user:${OWNER}:calendar`) {
        switched = true;
        await owners.switchOwner({ kind: 'user', id: 'user-b' });
        useCalendarStore.getState().replaceState({
          entries: {
            '2026-09-05': {
              date: '2026-09-05', miniStamps: {}, privacyLevel: 2,
              imageUri: 'file:///private/user-b.jpg',
            },
          },
          recurringSchedules: [],
          specialDates: [],
          weekStartDay: 1,
        });
      }
    };
    const adapter = createProductionPersonalMediaLocalAdapter({
      ownerId: OWNER,
      ownerStorage: owners,
      storage,
    });

    await expect(adapter.replaceIfCurrent({
      entity: 'calendar-entry',
      entityId: '2026-09-05',
      domain: 'calendar',
      field: 'imageUri',
    }, 'file:///private/old-owner.jpg', `${OWNER}/calendar/${MEDIA_ID}.jpg`))
      .resolves.toBe('replaced');

    const persisted = JSON.parse(storage.values.get(`recoto:user:${OWNER}:calendar`)!);
    expect(persisted.state.entries['2026-09-05'].imageUri)
      .toBe(`${OWNER}/calendar/${MEDIA_ID}.jpg`);
    expect(useCalendarStore.getState().entries['2026-09-05'].imageUri)
      .toBe('file:///private/user-b.jpg');
  });
});
