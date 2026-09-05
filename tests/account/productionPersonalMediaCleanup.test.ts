jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import { ACCOUNT_TRANSITION_MEDIA_DOMAIN } from '../../lib/account/accountBootstrapPersistence';
import { PERSONAL_MEDIA_SYNC_DOMAIN } from '../../lib/account/productionPersonalMedia';
import {
  clearPersonalMediaForOwner,
  type PersonalMediaLocalArtifactCleaner,
} from '../../lib/account/productionPersonalMediaCleanup';
import type { KeyValueStorage } from '../../lib/account/namespacedStorage';
import type { PersonalMediaSyncState } from '../../lib/account/personalMediaSync';

const OWNER = 'user-a';
const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';
const FIRST_STAGE = `file:///app/Documents/recoto-media-outbox/${FIRST_ID}.jpg`;
const SECOND_STAGE = `recoto-idb://${SECOND_ID}.jpg`;
const STATE_KEY = `recoto:user:${OWNER}:${PERSONAL_MEDIA_SYNC_DOMAIN}`;
const HANDOFF_KEY = `recoto:user:${OWNER}:${ACCOUNT_TRANSITION_MEDIA_DOMAIN}`;

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  readonly operations: string[] = [];
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) {
    this.operations.push(`pointer:${key}`);
    this.values.delete(key);
  }
}

function syncState(): PersonalMediaSyncState {
  return {
    version: 1,
    uploads: [{
      target: {
        entity: 'calendar-entry',
        entityId: '2026-09-05',
        domain: 'calendar',
        field: 'imageUri',
      },
      sourceUri: 'file:///app/cache/picker.jpg',
      phase: 'prepared',
      pending: {
        mutationId: FIRST_ID,
        ownerId: OWNER,
        domain: 'calendar',
        objectKey: `${OWNER}/calendar/${FIRST_ID}.jpg`,
        stagedUri: FIRST_STAGE,
        attempts: 1,
      },
    }],
    cleanups: [],
    stagedCleanups: [{ stagedUri: SECOND_STAGE, afterMutationId: SECOND_ID }],
  };
}

function fixture() {
  const storage = new MemoryStorage();
  storage.values.set(STATE_KEY, JSON.stringify(syncState()));
  storage.values.set(HANDOFF_KEY, JSON.stringify({
    version: 1,
    targetUserId: OWNER,
    entries: {
      '2026-09-05': { imageUri: 'file:///app/cache/picker.jpg' },
    },
    stamps: {},
  }));
  const artifacts = new Set([FIRST_STAGE, SECOND_STAGE, 'file:///app/cache/picker.jpg']);
  const cleaner: PersonalMediaLocalArtifactCleaner = {
    removeAndVerify: jest.fn(async (uri) => {
      storage.operations.push(`artifact:${uri}`);
      artifacts.delete(uri);
      if (artifacts.has(uri)) throw new Error('artifact still exists');
      return true;
    }),
  };
  return { storage, artifacts, cleaner };
}

describe('production personal media deletion boundary', () => {
  test('removes and verifies every local artifact before deleting either pointer', async () => {
    const f = fixture();

    await expect(clearPersonalMediaForOwner({
      ownerId: OWNER,
      storage: f.storage,
      cleaner: f.cleaner,
    })).resolves.toEqual({ removedArtifacts: 3 });

    expect(f.artifacts).toEqual(new Set());
    expect(f.storage.values.has(STATE_KEY)).toBe(false);
    expect(f.storage.values.has(HANDOFF_KEY)).toBe(false);
    const firstPointer = f.storage.operations.findIndex((value) => value.startsWith('pointer:'));
    expect(f.storage.operations.slice(0, firstPointer).every(
      (value) => value.startsWith('artifact:'),
    )).toBe(true);
  });

  test('keeps both pointers when artifact cleanup fails and can be retried idempotently', async () => {
    const f = fixture();
    let failOnce = true;
    f.cleaner.removeAndVerify = jest.fn(async (uri) => {
      f.storage.operations.push(`artifact:${uri}`);
      if (uri === SECOND_STAGE && failOnce) {
        failOnce = false;
        throw new Error('IndexedDB delete was not verified');
      }
      f.artifacts.delete(uri);
      return true;
    });

    await expect(clearPersonalMediaForOwner({
      ownerId: OWNER,
      storage: f.storage,
      cleaner: f.cleaner,
    })).rejects.toThrow('not verified');
    expect(f.storage.values.has(STATE_KEY)).toBe(true);
    expect(f.storage.values.has(HANDOFF_KEY)).toBe(true);

    await clearPersonalMediaForOwner({
      ownerId: OWNER,
      storage: f.storage,
      cleaner: f.cleaner,
    });
    expect(f.storage.values.has(STATE_KEY)).toBe(false);
    expect(f.storage.values.has(HANDOFF_KEY)).toBe(false);
  });

  test('rejects a cross-owner state without touching artifacts or pointers', async () => {
    const f = fixture();
    const invalid = syncState();
    invalid.uploads[0].pending.ownerId = 'user-b';
    f.storage.values.set(STATE_KEY, JSON.stringify(invalid));

    await expect(clearPersonalMediaForOwner({
      ownerId: OWNER,
      storage: f.storage,
      cleaner: f.cleaner,
    })).rejects.toThrow(/sync state/i);

    expect(f.cleaner.removeAndVerify).not.toHaveBeenCalled();
    expect(f.storage.values.has(STATE_KEY)).toBe(true);
    expect(f.storage.values.has(HANDOFF_KEY)).toBe(true);
  });
});
