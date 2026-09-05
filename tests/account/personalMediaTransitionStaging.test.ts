import {
  createPersonalMediaTransitionStager,
} from '../../lib/account/personalMediaTransitionStaging';
import type {
  PendingMediaUpload,
  PersonalMediaService,
} from '../../lib/account/personalMedia';
import type {
  PersonalMediaSyncState,
} from '../../lib/account/personalMediaSync';
import type { PersonalSnapshot } from '../../types/account';

const OWNER = 'user-a';
const uuid = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

function snapshot(): PersonalSnapshot {
  return {
    entries: {
      '2026-09-05': {
        date: '2026-09-05',
        miniStamps: {},
        privacyLevel: 2,
        imageUri: 'blob:https://recoto.test/calendar',
        diaryPhotos: [
          'content://picker/diary',
          `${OWNER}/diary/99999999-9999-4999-8999-999999999999.jpg`,
        ],
      },
    },
    specialDates: [],
    preferences: {},
    stamps: [{
      id: 'photo', text: '', bgColor: '#fff', textColor: '#000',
      imageUri: 'file:///app/cache/stamp.jpg',
    }],
    trips: [],
    tripItems: [],
  };
}

describe('guest transition personal media staging', () => {
  test('durably prepares every device source before owner switch and is restart-idempotent', async () => {
    let state: PersonalMediaSyncState = {
      version: 1, uploads: [], cleanups: [], stagedCleanups: [],
    };
    let nextId = 0;
    const prepare = jest.fn(async ({
      ownerId,
      domain,
      sourceUri,
      persistPending,
    }: {
      ownerId: string;
      domain: 'calendar' | 'diary' | 'stamp' | 'trip';
      sourceUri: string;
      persistPending(value: PendingMediaUpload): Promise<void>;
    }) => {
      const mutationId = uuid(++nextId);
      const pending: PendingMediaUpload = {
        mutationId,
        ownerId,
        domain,
        objectKey: `${ownerId}/${domain}/${mutationId}.jpg`,
        stagedUri: `file:///app/Documents/recoto-media-outbox/${mutationId}.jpg`,
        attempts: 0,
      };
      await persistPending(pending);
      return pending;
    });
    const stager = createPersonalMediaTransitionStager({
      persistence: {
        read: async () => structuredClone(state),
        write: async (_ownerId, next) => { state = structuredClone(next); },
      },
      service: { prepare },
    });

    await stager.stage(OWNER, snapshot());
    expect(state.uploads).toHaveLength(3);
    expect(state.uploads.map((job) => job.sourceUri)).toEqual([
      'blob:https://recoto.test/calendar',
      'content://picker/diary',
      'file:///app/cache/stamp.jpg',
    ]);

    await stager.stage(OWNER, snapshot());
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(state.uploads).toHaveLength(3);
  });

  test('retries after a partial prepare without duplicating the committed job', async () => {
    let state: PersonalMediaSyncState = {
      version: 1, uploads: [], cleanups: [], stagedCleanups: [],
    };
    let calls = 0;
    let failOnce = true;
    const service = {
      prepare: jest.fn(async (input: Parameters<PersonalMediaService['prepare']>[0]) => {
        calls += 1;
        if (calls === 2 && failOnce) {
          failOnce = false;
          throw new Error('processor interrupted');
        }
        const mutationId = uuid(calls);
        const pending: PendingMediaUpload = {
          mutationId,
          ownerId: input.ownerId,
          domain: input.domain,
          objectKey: `${input.ownerId}/${input.domain}/${mutationId}.jpg`,
          stagedUri: `file:///app/Documents/recoto-media-outbox/${mutationId}.jpg`,
          attempts: 0,
        };
        await input.persistPending(pending);
        return pending;
      }),
    };
    const stager = createPersonalMediaTransitionStager({
      persistence: {
        read: async () => structuredClone(state),
        write: async (_ownerId, next) => { state = structuredClone(next); },
      },
      service,
    });

    await expect(stager.stage(OWNER, snapshot())).rejects.toThrow('interrupted');
    expect(state.uploads).toHaveLength(1);
    await stager.stage(OWNER, snapshot());

    expect(state.uploads).toHaveLength(3);
    expect(state.uploads.filter(
      (job) => job.sourceUri === 'blob:https://recoto.test/calendar',
    )).toHaveLength(1);
  });

  test('durably retires an older staged source when the guest edits before retry', async () => {
    const oldId = uuid(8);
    let state: PersonalMediaSyncState = {
      version: 1,
      uploads: [{
        target: {
          entity: 'calendar-entry', entityId: '2026-09-05',
          domain: 'calendar', field: 'imageUri',
        },
        sourceUri: 'blob:https://recoto.test/old',
        phase: 'prepared',
        pending: {
          mutationId: oldId,
          ownerId: OWNER,
          domain: 'calendar',
          objectKey: `${OWNER}/calendar/${oldId}.jpg`,
          stagedUri: `file:///app/Documents/recoto-media-outbox/${oldId}.jpg`,
          attempts: 0,
        },
      }],
      cleanups: [],
      stagedCleanups: [],
    };
    const replacement = snapshot();
    replacement.entries['2026-09-05'].imageUri = 'blob:https://recoto.test/new';
    let nextId = 20;
    const service = {
      prepare: jest.fn(async (input: Parameters<PersonalMediaService['prepare']>[0]) => {
        const mutationId = uuid(++nextId);
        const pending: PendingMediaUpload = {
          mutationId,
          ownerId: input.ownerId,
          domain: input.domain,
          objectKey: `${input.ownerId}/${input.domain}/${mutationId}.jpg`,
          stagedUri: `file:///app/Documents/recoto-media-outbox/${mutationId}.jpg`,
          attempts: 0,
        };
        await input.persistPending(pending);
        return pending;
      }),
    };
    const stager = createPersonalMediaTransitionStager({
      persistence: {
        read: async () => structuredClone(state),
        write: async (_ownerId, next) => { state = structuredClone(next); },
      },
      service,
      now: () => new Date('2026-09-05T12:00:00.000Z'),
    });

    await stager.stage(OWNER, replacement);

    expect(state.uploads.some((job) => job.sourceUri === 'blob:https://recoto.test/old'))
      .toBe(false);
    expect(state.uploads.some((job) => job.sourceUri === 'blob:https://recoto.test/new'))
      .toBe(true);
    expect(state.stagedCleanups).toContainEqual({
      stagedUri: `file:///app/Documents/recoto-media-outbox/${oldId}.jpg`,
      afterMutationId: oldId,
    });
    expect(state.cleanups).toContainEqual({
      objectKey: `${OWNER}/calendar/${oldId}.jpg`,
      queuedAt: '2026-09-05T12:00:00.000Z',
    });
  });
});
