import type { SupabaseClient } from '@supabase/supabase-js';
import type { DayEntry, Stamp } from '../../types';
import type { PersonalSnapshot } from '../../types/account';
import type { Trip } from '../../types/travel';
import { useCalendarStore } from '../../store/calendarStore';
import { useLocaleStore } from '../../store/localeStore';
import { useStampStore } from '../../store/stampStore';
import { useTripStore } from '../../store/tripStore';
import type { KeyValueStorage, OwnerStorage } from './namespacedStorage';
import type { AccountCloudSyncTriggerProducer } from './accountCloudSyncTriggers';
import {
  clearAccountTransitionMediaHandoff,
  snapshotFromCloudRows,
} from './accountBootstrapPersistence';
import type { AccountOutboxProducerPersistence } from './outboxProducer';
import {
  createPlatformMediaStaging,
  createPlatformJpegProcessor,
  createPersonalMediaService,
  createSupabasePersonalMediaStorage,
} from './personalMedia';
import { createPortableSnapshot } from './personalSnapshot';
import {
  createPersonalMediaCleanupQueue,
  createPersonalMediaSyncPersistence,
} from './productionPersonalMedia';
import {
  createPersonalMediaSyncWorker,
  readPersonalMediaTarget,
  type PersonalMediaLocalAdapter,
  type PersonalMediaTarget,
} from './personalMediaSync';

const SAFE_OWNER_PATTERN = /^[A-Za-z0-9_-]+$/;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireOwner(ownerId: string) {
  if (!SAFE_OWNER_PATTERN.test(ownerId)) throw new Error('Invalid personal media owner');
}

function currentSnapshotInput() {
  const calendar = useCalendarStore.getState();
  const stamps = useStampStore.getState();
  const trips = useTripStore.getState();
  return {
    entries: calendar.entries,
    specialDates: calendar.specialDates,
    preferences: {
      weekStartDay: calendar.weekStartDay,
      recurringSchedules: calendar.recurringSchedules,
      locale: useLocaleStore.getState().locale,
    },
    stamps: stamps.stamps,
    trips: trips.trips,
    tripItems: trips.items,
  };
}

/** Includes device-only fields which createPortableSnapshot intentionally omits. */
export function readRuntimePersonalMediaSnapshot(): PersonalSnapshot {
  const input = currentSnapshotInput();
  const snapshot = createPortableSnapshot(input);
  for (const [id, entry] of Object.entries(input.entries)) {
    const portable = snapshot.entries[id];
    if (!portable) continue;
    if (typeof entry.imageUri === 'string') portable.imageUri = entry.imageUri;
    if (entry.diaryPhotos) portable.diaryPhotos = [...entry.diaryPhotos];
  }
  const stampsById = new Map(input.stamps.map((stamp) => [stamp.id, stamp]));
  snapshot.stamps.forEach((portable) => {
    const imageUri = stampsById.get(portable.id)?.imageUri;
    if (typeof imageUri === 'string') portable.imageUri = imageUri;
  });
  return snapshot;
}

function calendarStateForPersistence() {
  const state = useCalendarStore.getState();
  return {
    entries: clone(state.entries),
    recurringSchedules: clone(state.recurringSchedules),
    specialDates: clone(state.specialDates),
    weekStartDay: state.weekStartDay,
  };
}

function stampStateForPersistence() {
  return { stamps: clone(useStampStore.getState().stamps) };
}

function tripStateForPersistence() {
  const state = useTripStore.getState();
  return { trips: clone(state.trips), items: clone(state.items) };
}

function persistedTarget(raw: string, target: PersonalMediaTarget): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid persisted personal media store');
  }
  if (!parsed || typeof parsed !== 'object' || !('state' in parsed)) {
    throw new Error('Invalid persisted personal media store');
  }
  const state = (parsed as { state: Record<string, unknown> }).state;
  if (target.entity === 'calendar-entry') {
    const entries = state.entries as Record<string, DayEntry> | undefined;
    const entry = entries?.[target.entityId];
    if (target.field === 'imageUri') return entry?.imageUri;
    return entry?.diaryPhotos?.[target.index ?? -1];
  }
  if (target.entity === 'stamp') {
    return (state.stamps as Stamp[] | undefined)
      ?.find((stamp) => stamp.id === target.entityId)?.imageUri;
  }
  const trip = (state.trips as Trip[] | undefined)
    ?.find((candidate) => candidate.id === target.entityId) as
      | (Trip & { coverImageUri?: string; photos?: string[] })
      | undefined;
  if (target.field === 'coverImageUri') return trip?.coverImageUri;
  return trip?.photos?.[target.index ?? -1];
}

function domainForTarget(target: PersonalMediaTarget): 'calendar' | 'stamps' | 'trips' {
  if (target.entity === 'calendar-entry') return 'calendar';
  if (target.entity === 'stamp') return 'stamps';
  return 'trips';
}

function serializedDomain(target: PersonalMediaTarget): string {
  const state = target.entity === 'calendar-entry'
    ? calendarStateForPersistence()
    : target.entity === 'stamp'
      ? stampStateForPersistence()
      : tripStateForPersistence();
  return JSON.stringify({ state, version: 0 });
}

function applyReplacement(
  target: PersonalMediaTarget,
  expected: string,
  replacement: string,
): boolean {
  const before = readPersonalMediaTarget(readRuntimePersonalMediaSnapshot(), target);
  if (before !== expected) return false;
  if (target.entity === 'calendar-entry' && target.field === 'imageUri') {
    useCalendarStore.getState().setImageUri(target.entityId, replacement);
    return true;
  }
  if (target.entity === 'calendar-entry' && target.field === 'diaryPhotos') {
    const entry = useCalendarStore.getState().entries[target.entityId];
    const photos = [...(entry?.diaryPhotos ?? [])];
    if (photos[target.index ?? -1] !== expected) return false;
    photos[target.index!] = replacement;
    useCalendarStore.getState().setDiaryPhotos(target.entityId, photos);
    return true;
  }
  if (target.entity === 'stamp' && target.field === 'imageUri') {
    useStampStore.getState().updateStamp(target.entityId, { imageUri: replacement });
    return true;
  }
  // Reserved trip fields are not accepted until the trip store ships them.
  return false;
}

export function createProductionPersonalMediaLocalAdapter({
  ownerId,
  ownerStorage,
  storage,
}: {
  ownerId: string;
  ownerStorage: OwnerStorage;
  storage: KeyValueStorage;
}): PersonalMediaLocalAdapter {
  requireOwner(ownerId);
  const isCurrent = async () => {
    const owner = await ownerStorage.getOwner();
    return owner.kind === 'user' && owner.id === ownerId;
  };
  const persistCurrent = async (target: PersonalMediaTarget, expectedValue: string | undefined) => {
    const domain = domainForTarget(target);
    const key = `recoto:user:${ownerId}:${domain}`;
    const serialized = serializedDomain(target);
    await storage.setItem(key, serialized);
    const verified = await storage.getItem(key);
    if (verified === null || persistedTarget(verified, target) !== expectedValue) {
      throw new Error('Personal media store write could not be verified');
    }
  };

  return {
    snapshot: readRuntimePersonalMediaSnapshot,
    read: (target) => readPersonalMediaTarget(readRuntimePersonalMediaSnapshot(), target),
    async replaceIfCurrent(target, expected, replacement) {
      if (!await isCurrent()) return 'superseded';
      if (!applyReplacement(target, expected, replacement)) return 'stale';
      await persistCurrent(target, replacement);

      if (await isCurrent()) {
        const latest = readPersonalMediaTarget(readRuntimePersonalMediaSnapshot(), target);
        if (latest !== replacement) {
          // A newer local edit won the race. Make that edit durable as well and
          // let the worker schedule the now-unreferenced upload for cleanup.
          await persistCurrent(target, latest);
          return 'stale';
        }
      }
      return 'replaced';
    },
  };
}

export function createProductionPersonalMediaRuntime({
  ownerId,
  ownerStorage,
  storage,
  client,
  outboxPersistence,
  isCurrentOwner,
}: {
  ownerId: string;
  ownerStorage: OwnerStorage;
  storage: KeyValueStorage;
  client: SupabaseClient;
  outboxPersistence: AccountOutboxProducerPersistence;
  isCurrentOwner(): Promise<boolean>;
}) {
  const persistence = createPersonalMediaSyncPersistence({ storage });
  const staging = createPlatformMediaStaging();
  const mediaStorage = createSupabasePersonalMediaStorage(client);
  const service = createPersonalMediaService({
    processor: createPlatformJpegProcessor(),
    staging,
    storage: mediaStorage,
    cleanupQueue: createPersonalMediaCleanupQueue({ ownerId, persistence }),
  });
  return createPersonalMediaSyncWorker({
    ownerId,
    isCurrentOwner,
    persistence,
    local: createProductionPersonalMediaLocalAdapter({ ownerId, ownerStorage, storage }),
    publication: {
      async readPublishedSnapshot(selectedOwnerId) {
        const state = await outboxPersistence.readSyncState(selectedOwnerId);
        return state ? snapshotFromCloudRows(state.rows) : null;
      },
    },
    service,
    removeStaged: (uri) => staging.remove(uri),
    removeObjects: (keys) => mediaStorage.remove(keys),
    onSourcesDurablyStaged: () => clearAccountTransitionMediaHandoff(storage, ownerId),
  });
}

/** Serializes media preparation around the existing durable row producer. */
export function createMediaAwareCloudSyncProducer({
  media,
  cloud,
}: {
  media: ReturnType<typeof createPersonalMediaSyncWorker>;
  cloud: AccountCloudSyncTriggerProducer;
}): AccountCloudSyncTriggerProducer {
  return {
    async reconcileAndFlush() {
      let mediaResult: Awaited<ReturnType<typeof media.reconcile>> | null = null;
      let mediaError: unknown;
      try {
        mediaResult = await media.reconcile();
      } catch (error) {
        mediaError = error;
      }
      // Even a corrupt/unsupported local image must not prevent unrelated edits
      // from reaching the durable outbox. Its device URI hold still prevents any
      // unsafe network payload or shared baseline advancement.
      const result = await cloud.reconcileAndFlush();
      if (mediaError !== undefined) throw mediaError;
      if (mediaResult === null) throw new Error('Personal media reconciliation did not complete');
      if (mediaResult.status !== 'retryable-error' && mediaResult.status !== 'superseded') {
        await media.reconcile();
      }
      return result;
    },
    isApplyingRemote: () => cloud.isApplyingRemote(),
    noteLocalChange: () => cloud.noteLocalChange(),
    invalidate() {
      media.invalidate();
      cloud.invalidate();
    },
  };
}
