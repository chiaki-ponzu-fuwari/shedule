import {
  MAX_PERSONAL_MEDIA_BYTES,
  SIGNED_MEDIA_TTL_SECONDS,
  createBrowserMediaStaging,
  createPlatformJpegProcessor,
  createPersonalMediaService,
  createSupabasePersonalMediaStorage,
  processPendingMediaUpload,
  type PersonalMediaDomain,
} from '../../lib/account/personalMedia';

const MEDIA_UUID = '11111111-1111-4111-8111-111111111111';
const processedImage = {
  bytes: new ArrayBuffer(24),
  mimeType: 'image/jpeg' as const,
};

function fixture() {
  const operations: string[] = [];
  const processor = {
    reencodeAsJpeg: jest.fn(async () => processedImage),
  };
  const staging = {
    write: jest.fn(async (id: string) => `file:///documents/recoto-media/${id}.jpg`),
    read: jest.fn(async () => processedImage.bytes),
    remove: jest.fn(async () => undefined),
  };
  const storage = {
    uploadIfAbsent: jest.fn<
      Promise<'uploaded' | 'already-exists'>,
      [string, ArrayBuffer, 'image/jpeg']
    >(async () => {
      operations.push('upload');
      return 'uploaded' as const;
    }),
    createSignedUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
    remove: jest.fn(async () => {
      operations.push('remove');
    }),
  };
  const cleanupQueue = {
    enqueue: jest.fn<Promise<void>, [string]>(async (key: string) => {
      operations.push(`queue:${key}`);
    }),
    complete: jest.fn<Promise<void>, [string]>(async (key: string) => {
      operations.push(`cleaned:${key}`);
    }),
    enqueueStagedFile: jest.fn<Promise<void>, [string, string]>(async (uri: string) => {
      operations.push(`queue-stage:${uri}`);
    }),
    completeStagedFile: jest.fn<Promise<void>, [string]>(async (uri: string) => {
      operations.push(`cleaned-stage:${uri}`);
    }),
  };
  const service = createPersonalMediaService({
    processor,
    staging,
    storage,
    cleanupQueue,
    uuid: () => MEDIA_UUID,
  });
  const persisted: unknown[] = [];
  const persistPending = jest.fn(async (mutation) => {
    persisted.push(mutation);
    operations.push('persist-pending');
  });
  return {
    operations,
    processor,
    staging,
    storage,
    cleanupQueue,
    service,
    persisted,
    persistPending,
  };
}

async function prepare(
  f: ReturnType<typeof fixture>,
  domain: PersonalMediaDomain = 'calendar',
) {
  return f.service.prepare({
    ownerId: 'user-1',
    domain,
    sourceUri: 'content://picker/original.heic',
    persistPending: f.persistPending,
  });
}

describe('personal media', () => {
  test('re-encodes into durable staging and persists a fixed UUID key before upload', async () => {
    const f = fixture();

    const pending = await prepare(f);

    expect(f.processor.reencodeAsJpeg).toHaveBeenCalledWith('content://picker/original.heic');
    expect(f.staging.write).toHaveBeenCalledWith(MEDIA_UUID, processedImage.bytes);
    expect(pending).toEqual({
      mutationId: MEDIA_UUID,
      ownerId: 'user-1',
      domain: 'calendar',
      objectKey: `user-1/calendar/${MEDIA_UUID}.jpg`,
      stagedUri: `file:///documents/recoto-media/${MEDIA_UUID}.jpg`,
      attempts: 0,
    });
    expect(f.persistPending).toHaveBeenCalledWith(pending);
    expect(f.operations).toEqual(['persist-pending']);
    expect(f.storage.uploadIfAbsent).not.toHaveBeenCalled();

    await f.service.uploadPending(pending);
    expect(f.storage.uploadIfAbsent).toHaveBeenCalledWith(
      pending.objectKey,
      processedImage.bytes,
      'image/jpeg',
    );
  });

  test('uses the same object key after an ambiguous upload failure and persists retry attempts', async () => {
    const f = fixture();
    const pending = await prepare(f);
    f.storage.uploadIfAbsent
      .mockRejectedValueOnce(new Error('connection lost after send'))
      .mockResolvedValueOnce('already-exists');
    const persistRetry = jest.fn(async () => undefined);

    const first = await processPendingMediaUpload(pending, f.service, persistRetry);
    expect(first).toEqual({
      status: 'pending',
      mutation: { ...pending, attempts: 1 },
      error: 'connection lost after send',
    });
    expect(persistRetry).toHaveBeenCalledWith({ ...pending, attempts: 1 });

    await expect(
      processPendingMediaUpload({ ...pending, attempts: 1 }, f.service, persistRetry),
    ).resolves.toEqual({
      status: 'uploaded',
      objectKey: pending.objectKey,
      mutationId: pending.mutationId,
    });
    expect(f.storage.uploadIfAbsent.mock.calls.map(([key]) => key)).toEqual([
      pending.objectKey,
      pending.objectKey,
    ]);
  });

  test('gates cleanup without deleting the retry source after an ambiguous outbox failure', async () => {
    const f = fixture();
    let remotelyCommitted = false;
    f.persistPending.mockImplementationOnce(async () => {
      remotelyCommitted = true;
      throw new Error('response lost after outbox commit');
    });

    await expect(prepare(f)).rejects.toThrow('response lost after outbox commit');
    expect(remotelyCommitted).toBe(true);
    expect(f.cleanupQueue.enqueueStagedFile).toHaveBeenCalledWith(
      `file:///documents/recoto-media/${MEDIA_UUID}.jpg`,
      MEDIA_UUID,
    );
    expect(f.staging.remove).not.toHaveBeenCalled();
    expect(f.cleanupQueue.completeStagedFile).not.toHaveBeenCalled();
    expect(f.storage.uploadIfAbsent).not.toHaveBeenCalled();
  });

  test('uses short-lived signed reads and rejects cross-owner or cross-domain keys', async () => {
    const f = fixture();
    const ownKey = `user-1/diary/${MEDIA_UUID}.jpg`;

    await expect(f.service.createSignedReadUrl('user-1', 'diary', ownKey))
      .resolves.toBe(`https://signed.example/${ownKey}`);
    expect(f.storage.createSignedUrl).toHaveBeenCalledWith(ownKey, SIGNED_MEDIA_TTL_SECONDS);
    expect(SIGNED_MEDIA_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);

    await expect(f.service.createSignedReadUrl(
      'user-1', 'diary', `user-2/diary/${MEDIA_UUID}.jpg`,
    )).rejects.toThrow(/owner/i);
    await expect(f.service.createSignedReadUrl(
      'user-1', 'diary', `user-1/calendar/${MEDIA_UUID}.jpg`,
    )).rejects.toThrow(/domain/i);
  });

  test('validates the old domain before replacement side effects and deletes it after DB persistence', async () => {
    const f = fixture();
    const pending = await prepare(f, 'diary');
    const discardPending = jest.fn(async () => {
      f.operations.push('discard-pending');
    });

    await expect(f.service.replace({
      mutation: pending,
      previousObjectKey: `user-1/calendar/${MEDIA_UUID}.jpg`,
      persistObjectKey: async () => undefined,
      discardPending,
    })).rejects.toThrow(/domain/i);
    expect(f.storage.uploadIfAbsent).not.toHaveBeenCalled();

    f.operations.length = 0;
    const oldKey = 'user-1/diary/22222222-2222-4222-8222-222222222222.jpg';
    const result = await f.service.replace({
      mutation: pending,
      previousObjectKey: oldKey,
      persistObjectKey: async (key) => {
        f.operations.push(`persist-db:${key}`);
      },
      discardPending,
    });

    expect(result).toEqual({ objectKey: pending.objectKey });
    expect(f.operations).toEqual([
      'upload',
      `persist-db:${pending.objectKey}`,
      `queue:${oldKey}`,
      `queue-stage:${pending.stagedUri}`,
      'discard-pending',
      `cleaned-stage:${pending.stagedUri}`,
      'remove',
      `cleaned:${oldKey}`,
    ]);
    expect(f.staging.remove).toHaveBeenCalledWith(pending.stagedUri);
  });

  test('schedules a newly uploaded object for cleanup when DB persistence fails', async () => {
    const f = fixture();
    const pending = await prepare(f, 'diary');
    const discardPending = jest.fn(async () => {
      f.operations.push('discard-pending');
    });
    f.operations.length = 0;

    await expect(f.service.replace({
      mutation: pending,
      persistObjectKey: async () => { throw new Error('database offline'); },
      discardPending,
    })).rejects.toThrow('database offline');

    expect(f.cleanupQueue.enqueue).toHaveBeenCalledWith(pending.objectKey);
    expect(discardPending).toHaveBeenCalledWith(pending.mutationId);
    expect(f.staging.remove).toHaveBeenCalledWith(pending.stagedUri);
    expect(f.operations).toEqual([
      'upload',
      `queue:${pending.objectKey}`,
      `queue-stage:${pending.stagedUri}`,
      'discard-pending',
      `cleaned-stage:${pending.stagedUri}`,
    ]);
  });

  test('leaves a durable cleanup job when old-object removal fails', async () => {
    const f = fixture();
    const pending = await prepare(f, 'diary');
    const oldKey = 'user-1/diary/22222222-2222-4222-8222-222222222222.jpg';
    f.storage.remove.mockRejectedValueOnce(new Error('storage offline'));

    await expect(f.service.replace({
      mutation: pending,
      previousObjectKey: oldKey,
      persistObjectKey: async () => undefined,
      discardPending: async () => undefined,
    })).resolves.toEqual({ objectKey: pending.objectKey, cleanupPending: true });
    expect(f.cleanupQueue.enqueue).toHaveBeenCalledWith(oldKey);
    expect(f.cleanupQueue.enqueueStagedFile).toHaveBeenCalledWith(
      pending.stagedUri,
      pending.mutationId,
    );
    expect(f.cleanupQueue.completeStagedFile).toHaveBeenCalledWith(pending.stagedUri);
    expect(f.cleanupQueue.complete).not.toHaveBeenCalledWith(oldKey);
  });

  test('keeps the upload retryable when old-object cleanup cannot be queued', async () => {
    const f = fixture();
    const pending = await prepare(f, 'diary');
    const oldKey = 'user-1/diary/22222222-2222-4222-8222-222222222222.jpg';
    const discardPending = jest.fn(async () => undefined);
    f.cleanupQueue.enqueue.mockRejectedValueOnce(new Error('cleanup outbox unavailable'));

    await expect(f.service.replace({
      mutation: pending,
      previousObjectKey: oldKey,
      persistObjectKey: async () => undefined,
      discardPending,
    })).rejects.toThrow('cleanup outbox unavailable');

    expect(discardPending).not.toHaveBeenCalled();
    expect(f.staging.remove).not.toHaveBeenCalledWith(pending.stagedUri);
    expect(f.storage.remove).not.toHaveBeenCalled();
  });

  test('preserves the durable old-object cleanup when local stage removal fails', async () => {
    const f = fixture();
    const pending = await prepare(f, 'diary');
    const oldKey = 'user-1/diary/22222222-2222-4222-8222-222222222222.jpg';
    f.staging.remove.mockRejectedValueOnce(new Error('local file busy'));

    await expect(f.service.replace({
      mutation: pending,
      previousObjectKey: oldKey,
      persistObjectKey: async () => undefined,
      discardPending: async () => undefined,
    })).resolves.toEqual({ objectKey: pending.objectKey, cleanupPending: true });

    expect(f.cleanupQueue.enqueue).toHaveBeenCalledWith(oldKey);
    expect(f.cleanupQueue.enqueueStagedFile).toHaveBeenCalledWith(
      pending.stagedUri,
      pending.mutationId,
    );
    expect(f.cleanupQueue.completeStagedFile).not.toHaveBeenCalledWith(pending.stagedUri);
    expect(f.storage.remove).toHaveBeenCalledWith([oldKey]);
  });

  test('recognizes only known Supabase duplicate conflicts as an idempotent upload', async () => {
    const upload = jest.fn()
      .mockResolvedValueOnce({
        data: null,
        error: {
          status: 409,
          statusCode: 'KeyAlreadyExists',
          message: 'The resource already exists',
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: { status: 409, statusCode: 'PolicyConflict', message: 'Conflict' },
      });
    const storage = createSupabasePersonalMediaStorage({
      storage: {
        from: () => ({
          upload,
          createSignedUrl: jest.fn(),
          remove: jest.fn(),
        }),
      },
    } as never);

    await expect(storage.uploadIfAbsent('user-1/calendar/a.jpg', processedImage.bytes, 'image/jpeg'))
      .resolves.toBe('already-exists');
    await expect(storage.uploadIfAbsent('user-1/calendar/b.jpg', processedImage.bytes, 'image/jpeg'))
      .rejects.toMatchObject({ statusCode: 'PolicyConflict' });
  });

  test('uses a durable browser store instead of the unavailable Expo web directory', async () => {
    const records = new Map<string, ArrayBuffer>();
    const database = {
      put: jest.fn(async (id: string, bytes: ArrayBuffer) => {
        records.set(id, bytes.slice(0));
      }),
      get: jest.fn(async (id: string) => records.get(id)?.slice(0) ?? null),
      remove: jest.fn(async (id: string) => {
        records.delete(id);
      }),
    };
    const staging = createBrowserMediaStaging(database);

    const uri = await staging.write(MEDIA_UUID, processedImage.bytes);
    expect(uri).toBe(`recoto-idb://${MEDIA_UUID}.jpg`);
    await expect(staging.read(uri)).resolves.toEqual(processedImage.bytes);
    await staging.remove(uri);
    await expect(staging.read(uri)).rejects.toThrow(/no longer available/i);
  });

  test('reads the re-encoded JPEG with fetch on web instead of Expo FileSystem', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]).buffer;
    const fetcher = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => bytes,
    }));
    const processor = createPlatformJpegProcessor({
      platform: 'web',
      reencode: async () => ({ uri: 'blob:https://recoto.example/reencoded' }),
      fetcher,
    });

    await expect(processor.reencodeAsJpeg('blob:https://recoto.example/original'))
      .resolves.toEqual({ bytes, mimeType: 'image/jpeg' });
    expect(fetcher).toHaveBeenCalledWith('blob:https://recoto.example/reencoded');
  });

  test('rejects invalid UUIDs, non-JPEG output, and oversized actual bytes', async () => {
    const f = fixture();
    const invalidUuidService = createPersonalMediaService({
      processor: f.processor,
      staging: f.staging,
      storage: f.storage,
      cleanupQueue: f.cleanupQueue,
      uuid: () => 'guessable-name',
    });
    await expect(invalidUuidService.prepare({
      ownerId: 'user-1', domain: 'calendar', sourceUri: 'file:///a.jpg',
      persistPending: f.persistPending,
    })).rejects.toThrow(/UUID/);

    f.processor.reencodeAsJpeg.mockResolvedValueOnce({
      bytes: processedImage.bytes,
      mimeType: 'image/png' as 'image/jpeg',
    });
    await expect(prepare(f)).rejects.toThrow(/JPEG/);

    f.processor.reencodeAsJpeg.mockResolvedValueOnce({
      bytes: new ArrayBuffer(MAX_PERSONAL_MEDIA_BYTES + 1),
      mimeType: 'image/jpeg',
    });
    await expect(prepare(f)).rejects.toThrow(/5 MB/);
    expect(f.storage.uploadIfAbsent).not.toHaveBeenCalled();
  });

  test('record deletion queues only the expected owner and domain key', async () => {
    const f = fixture();
    const key = `user-1/trip/${MEDIA_UUID}.jpg`;

    await f.service.scheduleCleanup('user-1', 'trip', key);
    expect(f.cleanupQueue.enqueue).toHaveBeenCalledWith(key);

    await expect(f.service.scheduleCleanup(
      'user-1', 'trip', `user-2/trip/${MEDIA_UUID}.jpg`,
    )).rejects.toThrow(/owner/i);
    await expect(f.service.scheduleCleanup(
      'user-1', 'trip', `user-1/stamp/${MEDIA_UUID}.jpg`,
    )).rejects.toThrow(/domain/i);
  });
});
