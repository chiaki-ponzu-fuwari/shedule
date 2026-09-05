import {
  createPersonalMediaSyncWorker,
  discoverPendingPersonalMediaTargets,
  parsePersonalMediaObjectKey,
  type PersonalMediaLocalAdapter,
  type PersonalMediaPublicationReader,
  type PersonalMediaSyncState,
} from '../../lib/account/personalMediaSync';
import type {
  PendingMediaUpload,
  PersonalMediaService,
} from '../../lib/account/personalMedia';
import type { PersonalSnapshot } from '../../types/account';

const OWNER = 'user-a';
const NOW = '2026-09-05T12:00:00.000Z';
const OLD_KEY = `${OWNER}/calendar/11111111-1111-4111-8111-111111111111.jpg`;

const uuid = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

function snapshot(imageUri?: string, diaryPhotos: string[] = []): PersonalSnapshot {
  return {
    entries: {
      '2026-09-05': {
        date: '2026-09-05',
        miniStamps: {},
        privacyLevel: 2,
        ...(imageUri ? { imageUri } : {}),
        ...(diaryPhotos.length ? { diaryPhotos } : {}),
      },
    },
    specialDates: [],
    preferences: {},
    stamps: [],
    trips: [],
    tripItems: [],
  };
}

function fixture(initialUri = 'file:///private/new.heic') {
  let currentOwner: string | null = OWNER;
  let local = snapshot(initialUri);
  let published: PersonalSnapshot | null = snapshot(OLD_KEY);
  let state: PersonalMediaSyncState = {
    version: 1,
    uploads: [],
    cleanups: [],
    stagedCleanups: [],
  };
  let nextUuid = 0;
  const removedObjects: string[] = [];
  const removedStages: string[] = [];
  const uploads: string[] = [];
  let afterUpload: (() => void) | undefined;
  let afterReplace: (() => void) | undefined;
  let uploadError: Error | undefined;
  let removeStageError: Error | undefined;
  let removeObjectError: Error | undefined;
  let failStateWriteAfterLocalPatch = false;
  const onSourcesDurablyStaged = jest.fn(async () => undefined);

  const persistence = {
    read: jest.fn(async () => structuredClone(state)),
    write: jest.fn(async (_ownerId: string, next: PersonalMediaSyncState) => {
      if (failStateWriteAfterLocalPatch && next.uploads.some((job) => job.phase === 'uploaded')) {
        failStateWriteAfterLocalPatch = false;
        throw new Error('state write interrupted');
      }
      state = structuredClone(next);
    }),
  };

  const readTarget = (target: { field: string; index?: number }) => {
    const entry = local.entries['2026-09-05'];
    if (target.field === 'imageUri') return entry?.imageUri;
    if (target.field === 'diaryPhotos') return entry?.diaryPhotos?.[target.index!];
    return undefined;
  };
  const localAdapter: PersonalMediaLocalAdapter = {
    snapshot: () => structuredClone(local),
    read: (target) => readTarget(target),
    replaceIfCurrent: jest.fn(async (target, expected, replacement) => {
      if (currentOwner !== OWNER) return 'superseded';
      if (readTarget(target) !== expected) return 'stale';
      if (target.field === 'imageUri') {
        local.entries[target.entityId] = {
          ...local.entries[target.entityId],
          imageUri: replacement,
        };
      } else {
        const photos = [...(local.entries[target.entityId]?.diaryPhotos ?? [])];
        photos[target.index!] = replacement;
        local.entries[target.entityId] = {
          ...local.entries[target.entityId],
          diaryPhotos: photos,
        };
      }
      afterReplace?.();
      return 'replaced';
    }),
  };

  const publication: PersonalMediaPublicationReader = {
    readPublishedSnapshot: jest.fn(async () => structuredClone(published)),
  };

  const service: PersonalMediaService = {
    prepare: jest.fn(async ({ ownerId, domain, sourceUri, persistPending }) => {
      const mutationId = uuid(++nextUuid);
      const pending: PendingMediaUpload = {
        mutationId,
        ownerId,
        domain,
        objectKey: `${ownerId}/${domain}/${mutationId}.jpg`,
        stagedUri: `file:///documents/recoto-media-outbox/${mutationId}.jpg`,
        attempts: 0,
      };
      await persistPending(pending);
      return pending;
    }),
    uploadPending: jest.fn(async (mutation) => {
      uploads.push(mutation.objectKey);
      afterUpload?.();
      if (uploadError) throw uploadError;
      return { objectKey: mutation.objectKey };
    }),
    replace: jest.fn(async () => { throw new Error('worker must not use eager replacement'); }),
    createSignedReadUrl: jest.fn(async (_ownerId, _domain, objectKey) =>
      `https://signed.example/${objectKey}`),
    scheduleCleanup: jest.fn(async () => undefined),
  };

  const worker = createPersonalMediaSyncWorker({
    ownerId: OWNER,
    isCurrentOwner: async () => currentOwner === OWNER,
    persistence,
    local: localAdapter,
    publication,
    service,
    removeStaged: async (uri) => {
      if (removeStageError) {
        const error = removeStageError;
        removeStageError = undefined;
        throw error;
      }
      removedStages.push(uri);
    },
    removeObjects: async (keys) => {
      if (removeObjectError) {
        const error = removeObjectError;
        removeObjectError = undefined;
        throw error;
      }
      removedObjects.push(...keys);
    },
    onSourcesDurablyStaged,
    now: () => new Date(NOW),
  });

  return {
    worker,
    persistence,
    localAdapter,
    publication,
    service,
    onSourcesDurablyStaged,
    uploads,
    removedObjects,
    removedStages,
    get local() { return local; },
    setLocal(next: PersonalSnapshot) { local = next; },
    setPublished(next: PersonalSnapshot | null) { published = next; },
    setOwner(next: string | null) { currentOwner = next; },
    setAfterUpload(action: (() => void) | undefined) { afterUpload = action; },
    setAfterReplace(action: (() => void) | undefined) { afterReplace = action; },
    setUploadError(error: Error | undefined) { uploadError = error; },
    setRemoveStageError(error: Error | undefined) { removeStageError = error; },
    setRemoveObjectError(error: Error | undefined) { removeObjectError = error; },
    failNextStateWriteAfterPatch() { failStateWriteAfterLocalPatch = true; },
    get state() { return state; },
  };
}

describe('personal media production sync worker', () => {
  test('discovers calendar, diary and stamp device media but not icon or remote values', () => {
    const value = snapshot('content://picker/calendar', [
      'blob:https://local/diary-1',
      'data:image/png;base64,AAAA',
      OLD_KEY,
    ]);
    value.stamps = [
      { id: 'photo', text: '', bgColor: '#fff', textColor: '#000', imageUri: 'file:///stamp' },
      { id: 'icon', text: '', bgColor: '#fff', textColor: '#000', imageUri: 'icon://heart' },
    ];

    expect(discoverPendingPersonalMediaTargets(value)).toEqual([
      expect.objectContaining({ domain: 'calendar', field: 'imageUri', sourceUri: 'content://picker/calendar' }),
      expect.objectContaining({ domain: 'diary', field: 'diaryPhotos', index: 0 }),
      expect.objectContaining({ domain: 'diary', field: 'diaryPhotos', index: 1 }),
      expect.objectContaining({ domain: 'stamp', entity: 'stamp', entityId: 'photo' }),
    ]);
  });

  test('uploads with a durable fixed key, patches locally, and finalizes only after publication', async () => {
    const f = fixture();

    await expect(f.worker.reconcile()).resolves.toMatchObject({
      status: 'pending-publication',
      uploaded: 1,
    });
    const key = f.state.uploads[0].pending.objectKey;
    const stagedUri = f.state.uploads[0].pending.stagedUri;
    expect(f.local.entries['2026-09-05'].imageUri).toBe(key);
    expect(f.state.uploads[0]).toMatchObject({ phase: 'uploaded', sourceUri: 'file:///private/new.heic' });
    expect(f.removedStages).toEqual([]);
    expect(f.removedObjects).toEqual([]);

    f.setPublished(snapshot(key));
    await expect(f.worker.reconcile()).resolves.toMatchObject({ status: 'idle' });
    expect(f.state.uploads).toEqual([]);
    expect(f.removedStages).toEqual([stagedUri]);
  });

  test('keeps the source URI and increments durable attempts while offline', async () => {
    const f = fixture();
    f.setUploadError(new Error('offline'));

    await expect(f.worker.reconcile()).resolves.toMatchObject({ status: 'retryable-error' });

    expect(f.local.entries['2026-09-05'].imageUri).toBe('file:///private/new.heic');
    expect(f.state.uploads).toHaveLength(1);
    expect(f.state.uploads[0].pending.attempts).toBe(1);
    expect(f.removedStages).toEqual([]);
    expect(f.onSourcesDurablyStaged).toHaveBeenCalledTimes(1);
  });

  test('never overwrites a newer edit that arrives while upload is in flight', async () => {
    const f = fixture();
    f.setAfterUpload(() => {
      f.setLocal(snapshot('file:///private/newer.heic'));
    });

    await f.worker.reconcile();

    expect(f.local.entries['2026-09-05'].imageUri).toBe('file:///private/newer.heic');
    expect(f.state.uploads).toEqual([]);
    expect(f.state.cleanups).toContainEqual(
      expect.objectContaining({ objectKey: f.uploads[0] }),
    );
    expect(f.removedObjects).toEqual([]);
  });

  test('owner switch during upload leaves the old owner job retryable and never patches another owner', async () => {
    const f = fixture();
    f.setAfterUpload(() => f.setOwner('user-b'));

    await expect(f.worker.reconcile()).resolves.toMatchObject({ status: 'superseded' });

    expect(f.local.entries['2026-09-05'].imageUri).toBe('file:///private/new.heic');
    expect(f.state.uploads).toHaveLength(1);
    expect(f.state.uploads[0].phase).toBe('prepared');
    expect(f.removedObjects).toEqual([]);
  });

  test('owner switch during the durable local patch stops before advancing the old owner job', async () => {
    const f = fixture();
    f.setAfterReplace(() => f.setOwner('user-b'));

    await expect(f.worker.reconcile()).resolves.toMatchObject({ status: 'superseded' });

    expect(f.state.uploads).toHaveLength(1);
    expect(f.state.uploads[0].phase).toBe('prepared');
    expect(f.removedObjects).toEqual([]);
  });

  test('recovers a crash after local patch without uploading a second object', async () => {
    const f = fixture();
    f.failNextStateWriteAfterPatch();

    await expect(f.worker.reconcile()).rejects.toThrow('state write interrupted');
    const uploadedKey = f.uploads[0];
    expect(f.local.entries['2026-09-05'].imageUri).toBe(uploadedKey);

    f.setPublished(snapshot(uploadedKey));
    await f.worker.reconcile();

    expect(f.uploads).toEqual([uploadedKey]);
    expect(f.state.uploads).toEqual([]);
    expect(f.removedStages).toHaveLength(1);
  });

  test('keeps failed staged-file cleanup durable after publication and retries it later', async () => {
    const f = fixture();
    await f.worker.reconcile();
    const uploadedKey = f.state.uploads[0].pending.objectKey;
    const stagedUri = f.state.uploads[0].pending.stagedUri;
    f.setPublished(snapshot(uploadedKey));
    f.setRemoveStageError(new Error('file busy'));

    await expect(f.worker.reconcile()).resolves.toMatchObject({ stagedCleanupPending: 1 });
    expect(f.state.uploads).toEqual([]);
    expect(f.state.stagedCleanups).toEqual([
      expect.objectContaining({ stagedUri }),
    ]);

    await f.worker.reconcile();
    expect(f.removedStages).toEqual([stagedUri]);
    expect(f.state.stagedCleanups).toEqual([]);
  });

  test('does not block row backup when an unreferenced object cleanup partially fails', async () => {
    const f = fixture();
    f.setLocal(snapshot());
    await f.worker.reconcile();
    f.setPublished(snapshot());
    f.setRemoveObjectError(new Error('storage cleanup offline'));

    await expect(f.worker.reconcile()).resolves.toMatchObject({ cleanupPending: 1 });
    expect(f.state.cleanups).toEqual([expect.objectContaining({ objectKey: OLD_KEY })]);

    await f.worker.reconcile();
    expect(f.removedObjects).toEqual([OLD_KEY]);
    expect(f.state.cleanups).toEqual([]);
  });

  test('queues deletion and replacement cleanup before sync, then removes only after no local or published reference remains', async () => {
    const f = fixture(undefined);
    f.setLocal(snapshot());

    await f.worker.reconcile();
    expect(f.state.cleanups).toEqual([expect.objectContaining({ objectKey: OLD_KEY })]);
    expect(f.removedObjects).toEqual([]);

    f.setPublished(snapshot());
    await f.worker.reconcile();
    expect(f.removedObjects).toEqual([OLD_KEY]);
    expect(f.state.cleanups).toEqual([]);
  });

  test('parses only UUID owner-scoped object keys in supported domains', () => {
    expect(parsePersonalMediaObjectKey(OLD_KEY)).toEqual({
      ownerId: OWNER,
      domain: 'calendar',
      mediaId: '11111111-1111-4111-8111-111111111111',
    });
    expect(parsePersonalMediaObjectKey(`user-b/calendar/${uuid(1)}.jpg`, OWNER)).toBeNull();
    expect(parsePersonalMediaObjectKey(`${OWNER}/unknown/${uuid(1)}.jpg`, OWNER)).toBeNull();
    expect(parsePersonalMediaObjectKey('https://evil.example/tracker.jpg', OWNER)).toBeNull();
  });
});
