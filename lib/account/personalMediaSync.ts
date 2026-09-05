import type { PersonalSnapshot } from '../../types/account';
import type {
  PendingMediaUpload,
  PersonalMediaDomain,
  PersonalMediaService,
} from './personalMedia';
import { isDurablePersonalMediaStagedUri } from './personalMedia';

const MEDIA_DOMAINS = ['calendar', 'diary', 'stamp', 'trip'] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OWNER_PATTERN = /^[A-Za-z0-9_-]+$/;

export type PersonalMediaField =
  | 'imageUri'
  | 'diaryPhotos'
  | 'coverImageUri'
  | 'photos';

export interface PersonalMediaTarget {
  entity: 'calendar-entry' | 'stamp' | 'trip';
  entityId: string;
  domain: PersonalMediaDomain;
  field: PersonalMediaField;
  index?: number;
}

export interface PendingPersonalMediaTarget extends PersonalMediaTarget {
  sourceUri: string;
}

export interface PersonalMediaUploadJob {
  target: PersonalMediaTarget;
  sourceUri: string;
  phase: 'prepared' | 'uploaded';
  pending: PendingMediaUpload;
}

export interface PersonalMediaCleanupJob {
  objectKey: string;
  queuedAt: string;
}

export interface PersonalMediaStagedCleanupJob {
  stagedUri: string;
  afterMutationId: string;
}

export interface PersonalMediaSyncState {
  version: 1;
  uploads: PersonalMediaUploadJob[];
  cleanups: PersonalMediaCleanupJob[];
  stagedCleanups: PersonalMediaStagedCleanupJob[];
}

export interface PersonalMediaSyncPersistence {
  read(ownerId: string): Promise<PersonalMediaSyncState>;
  write(ownerId: string, state: PersonalMediaSyncState): Promise<void>;
}

export interface PersonalMediaLocalAdapter {
  snapshot(): PersonalSnapshot;
  read(target: PersonalMediaTarget): string | undefined;
  replaceIfCurrent(
    target: PersonalMediaTarget,
    expected: string,
    replacement: string,
  ): Promise<'replaced' | 'stale' | 'superseded'>;
}

export interface PersonalMediaPublicationReader {
  readPublishedSnapshot(ownerId: string): Promise<PersonalSnapshot | null>;
}

export interface ParsedPersonalMediaObjectKey {
  ownerId: string;
  domain: PersonalMediaDomain;
  mediaId: string;
}

export type PersonalMediaSyncResult = {
  status: 'idle' | 'pending-publication' | 'retryable-error' | 'superseded';
  uploaded: number;
  pending: number;
  cleanupPending: number;
  stagedCleanupPending: number;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isDevicePersonalMediaUri(value: unknown): value is string {
  return typeof value === 'string'
    && /^(?:(?:file|content|blob):|data:image\/)/i.test(value);
}

export function parsePersonalMediaObjectKey(
  value: unknown,
  expectedOwnerId?: string,
): ParsedPersonalMediaObjectKey | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length !== 3 || !SAFE_OWNER_PATTERN.test(parts[0])) return null;
  if (expectedOwnerId !== undefined && parts[0] !== expectedOwnerId) return null;
  if (!MEDIA_DOMAINS.includes(parts[1] as PersonalMediaDomain)) return null;
  if (!parts[2].endsWith('.jpg')) return null;
  const mediaId = parts[2].slice(0, -4);
  if (!UUID_PATTERN.test(mediaId)) return null;
  return {
    ownerId: parts[0],
    domain: parts[1] as PersonalMediaDomain,
    mediaId,
  };
}

function addArrayTargets(
  result: PendingPersonalMediaTarget[],
  values: unknown,
  target: Omit<PersonalMediaTarget, 'index'>,
) {
  if (!Array.isArray(values)) return;
  values.forEach((value, index) => {
    if (isDevicePersonalMediaUri(value)) {
      result.push({ ...target, index, sourceUri: value });
    }
  });
}

/** Reads the runtime (not portable) snapshot so device-only URIs remain visible. */
export function discoverPendingPersonalMediaTargets(
  snapshot: PersonalSnapshot,
): PendingPersonalMediaTarget[] {
  const result: PendingPersonalMediaTarget[] = [];
  for (const [entityId, entry] of Object.entries(snapshot.entries)) {
    if (isDevicePersonalMediaUri(entry.imageUri)) {
      result.push({
        entity: 'calendar-entry',
        entityId,
        domain: 'calendar',
        field: 'imageUri',
        sourceUri: entry.imageUri,
      });
    }
    addArrayTargets(result, entry.diaryPhotos, {
      entity: 'calendar-entry',
      entityId,
      domain: 'diary',
      field: 'diaryPhotos',
    });
  }
  for (const stamp of snapshot.stamps) {
    if (!isDevicePersonalMediaUri(stamp.imageUri)) continue;
    result.push({
      entity: 'stamp',
      entityId: stamp.id,
      domain: 'stamp',
      field: 'imageUri',
      sourceUri: stamp.imageUri,
    });
  }

  // Travel currently has no photo picker, but these two fields reserve the
  // production path for a cover/photo picker without changing queue format.
  for (const tripValue of snapshot.trips) {
    const trip = tripValue as unknown as Record<string, unknown>;
    const entityId = typeof trip.id === 'string' ? trip.id : '';
    if (!entityId) continue;
    if (isDevicePersonalMediaUri(trip.coverImageUri)) {
      result.push({
        entity: 'trip',
        entityId,
        domain: 'trip',
        field: 'coverImageUri',
        sourceUri: trip.coverImageUri,
      });
    }
    addArrayTargets(result, trip.photos, {
      entity: 'trip',
      entityId,
      domain: 'trip',
      field: 'photos',
    });
  }
  return result;
}

export function readPersonalMediaTarget(
  snapshot: PersonalSnapshot | null,
  target: PersonalMediaTarget,
): string | undefined {
  if (!snapshot) return undefined;
  if (target.entity === 'calendar-entry') {
    const entry = snapshot.entries[target.entityId];
    if (!entry) return undefined;
    if (target.field === 'imageUri') return entry.imageUri;
    if (target.field === 'diaryPhotos') return entry.diaryPhotos?.[target.index ?? -1];
    return undefined;
  }
  if (target.entity === 'stamp') {
    return snapshot.stamps.find((stamp) => stamp.id === target.entityId)?.imageUri;
  }
  const trip = snapshot.trips.find((candidate) => candidate.id === target.entityId) as
    | (Record<string, unknown> & { id: string })
    | undefined;
  if (!trip) return undefined;
  if (target.field === 'coverImageUri') {
    return typeof trip.coverImageUri === 'string' ? trip.coverImageUri : undefined;
  }
  if (target.field === 'photos' && Array.isArray(trip.photos)) {
    const value = trip.photos[target.index ?? -1];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function targetKey(target: PersonalMediaTarget) {
  return [
    target.entity,
    target.entityId,
    target.domain,
    target.field,
    target.index ?? '',
  ].join('\u0000');
}

function collectObjectKeys(snapshot: PersonalSnapshot | null, ownerId: string): Set<string> {
  const keys = new Set<string>();
  if (!snapshot) return keys;
  const add = (value: unknown) => {
    if (parsePersonalMediaObjectKey(value, ownerId)) keys.add(value as string);
  };
  Object.values(snapshot.entries).forEach((entry) => {
    add(entry.imageUri);
    entry.diaryPhotos?.forEach(add);
  });
  snapshot.stamps.forEach((stamp) => add(stamp.imageUri));
  snapshot.trips.forEach((tripValue) => {
    const trip = tripValue as unknown as Record<string, unknown>;
    add(trip.coverImageUri);
    if (Array.isArray(trip.photos)) trip.photos.forEach(add);
  });
  return keys;
}

function addCleanup(
  state: PersonalMediaSyncState,
  objectKey: string,
  now: string,
) {
  if (!state.cleanups.some((cleanup) => cleanup.objectKey === objectKey)) {
    state.cleanups.push({ objectKey, queuedAt: now });
  }
}

function removeUpload(state: PersonalMediaSyncState, mutationId: string) {
  state.uploads = state.uploads.filter((job) => job.pending.mutationId !== mutationId);
}

function uploadForTarget(
  state: PersonalMediaSyncState,
  target: PersonalMediaTarget,
): PersonalMediaUploadJob | undefined {
  const key = targetKey(target);
  return state.uploads.find((job) => targetKey(job.target) === key);
}

function emptyResult(status: PersonalMediaSyncResult['status']): PersonalMediaSyncResult {
  return {
    status,
    uploaded: 0,
    pending: 0,
    cleanupPending: 0,
    stagedCleanupPending: 0,
  };
}

export function createPersonalMediaSyncWorker(options: {
  ownerId: string;
  isCurrentOwner(): Promise<boolean>;
  persistence: PersonalMediaSyncPersistence;
  local: PersonalMediaLocalAdapter;
  publication: PersonalMediaPublicationReader;
  service: Pick<PersonalMediaService, 'prepare' | 'uploadPending'>;
  removeStaged(stagedUri: string): Promise<void>;
  removeObjects(objectKeys: string[]): Promise<void>;
  /** Removes the guest migration handoff after each source has a durable job. */
  onSourcesDurablyStaged?(): Promise<void>;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();

  const persist = (state: PersonalMediaSyncState) =>
    options.persistence.write(options.ownerId, clone(state));

  const stillCurrent = async (startedGeneration: number) => (
    startedGeneration === generation && await options.isCurrentOwner()
  );

  const processCleanupQueue = async (
    state: PersonalMediaSyncState,
    localSnapshot: PersonalSnapshot,
    publishedSnapshot: PersonalSnapshot | null,
  ) => {
    const activeMutationIds = new Set(state.uploads.map((job) => job.pending.mutationId));
    for (const cleanup of [...state.stagedCleanups]) {
      if (activeMutationIds.has(cleanup.afterMutationId)) continue;
      try {
        await options.removeStaged(cleanup.stagedUri);
      } catch {
        continue;
      }
      state.stagedCleanups = state.stagedCleanups.filter((item) => (
        item.stagedUri !== cleanup.stagedUri
        || item.afterMutationId !== cleanup.afterMutationId
      ));
      await persist(state);
    }
    const referenced = new Set([
      ...collectObjectKeys(localSnapshot, options.ownerId),
      ...collectObjectKeys(publishedSnapshot, options.ownerId),
    ]);
    for (const cleanup of [...state.cleanups]) {
      if (referenced.has(cleanup.objectKey)) continue;
      try {
        await options.removeObjects([cleanup.objectKey]);
      } catch {
        continue;
      }
      state.cleanups = state.cleanups.filter((item) => item.objectKey !== cleanup.objectKey);
      await persist(state);
    }
  };

  const discardUpload = async (
    state: PersonalMediaSyncState,
    job: PersonalMediaUploadJob,
    cleanupObject: boolean,
  ) => {
    if (cleanupObject) addCleanup(state, job.pending.objectKey, now().toISOString());
    if (!state.stagedCleanups.some((cleanup) => (
      cleanup.stagedUri === job.pending.stagedUri
      && cleanup.afterMutationId === job.pending.mutationId
    ))) {
      state.stagedCleanups.push({
        stagedUri: job.pending.stagedUri,
        afterMutationId: job.pending.mutationId,
      });
    }
    // Persist both the absence and cleanup intent before removing the sole
    // durable retry source. A failed local deletion remains restart-safe.
    removeUpload(state, job.pending.mutationId);
    await persist(state);
    try {
      await options.removeStaged(job.pending.stagedUri);
    } catch {
      return;
    }
    state.stagedCleanups = state.stagedCleanups.filter((cleanup) => (
      cleanup.stagedUri !== job.pending.stagedUri
      || cleanup.afterMutationId !== job.pending.mutationId
    ));
    await persist(state);
  };

  const processUpload = async (
    state: PersonalMediaSyncState,
    job: PersonalMediaUploadJob,
    published: PersonalSnapshot | null,
    startedGeneration: number,
  ): Promise<PersonalMediaSyncResult['status'] | null> => {
    const current = options.local.read(job.target);
    if (job.phase === 'uploaded') {
      if (readPersonalMediaTarget(published, job.target) === job.pending.objectKey) {
        await discardUpload(state, job, false);
        return null;
      }
      if (current !== job.pending.objectKey) {
        await discardUpload(state, job, true);
      }
      return null;
    }

    // A crash can occur after the durable store patch but before the queue phase
    // write. Recognize that boundary and never upload a second object.
    if (current === job.pending.objectKey) {
      job.phase = 'uploaded';
      await persist(state);
      if (readPersonalMediaTarget(published, job.target) === job.pending.objectKey) {
        await discardUpload(state, job, false);
      }
      return null;
    }
    if (current !== job.sourceUri) {
      // An ambiguous upload may already have reached Storage, so cleanup the
      // fixed key even when this process only observes a prepared phase.
      await discardUpload(state, job, true);
      return null;
    }
    if (!await stillCurrent(startedGeneration)) return 'superseded';

    try {
      await options.service.uploadPending(job.pending);
    } catch {
      job.pending = { ...job.pending, attempts: job.pending.attempts + 1 };
      await persist(state);
      return 'retryable-error';
    }

    // Uploading is idempotent. If ownership changed while awaiting the network,
    // retain the old owner's fixed job instead of touching either visible store.
    if (!await stillCurrent(startedGeneration)) return 'superseded';
    const replacement = await options.local.replaceIfCurrent(
      job.target,
      job.sourceUri,
      job.pending.objectKey,
    );
    if (replacement === 'superseded') return 'superseded';
    if (!await stillCurrent(startedGeneration)) return 'superseded';
    if (replacement === 'stale') {
      await discardUpload(state, job, true);
      return null;
    }
    job.phase = 'uploaded';
    await persist(state);
    return null;
  };

  const run = async (startedGeneration: number): Promise<PersonalMediaSyncResult> => {
    if (!await stillCurrent(startedGeneration)) return emptyResult('superseded');
    const state = await options.persistence.read(options.ownerId);
    if (!await stillCurrent(startedGeneration)) return emptyResult('superseded');
    const published = await options.publication.readPublishedSnapshot(options.ownerId);
    if (!await stillCurrent(startedGeneration)) return emptyResult('superseded');

    // Cleanup is dependency-gated by both local and published references. Newly
    // queued cleanups intentionally wait for a later pass, proving durability.
    await processCleanupQueue(state, options.local.snapshot(), published);

    let uploaded = 0;
    for (const job of [...state.uploads]) {
      const wasPrepared = job.phase === 'prepared';
      const status = await processUpload(state, job, published, startedGeneration);
      if (wasPrepared && job.phase === 'uploaded') uploaded += 1;
      if (status) {
        return {
          status,
          uploaded,
          pending: state.uploads.length,
          cleanupPending: state.cleanups.length,
          stagedCleanupPending: state.stagedCleanups.length,
        };
      }
    }

    if (!await stillCurrent(startedGeneration)) {
      return {
        status: 'superseded',
        uploaded,
        pending: state.uploads.length,
        cleanupPending: state.cleanups.length,
        stagedCleanupPending: state.stagedCleanups.length,
      };
    }

    const localBeforeDiscovery = options.local.snapshot();
    const localKeys = collectObjectKeys(localBeforeDiscovery, options.ownerId);
    const publishedKeys = collectObjectKeys(published, options.ownerId);
    let cleanupAdded = false;
    for (const objectKey of publishedKeys) {
      if (!localKeys.has(objectKey) && !state.cleanups.some((job) => job.objectKey === objectKey)) {
        addCleanup(state, objectKey, now().toISOString());
        cleanupAdded = true;
      }
    }
    if (cleanupAdded) await persist(state);

    const targets = discoverPendingPersonalMediaTargets(localBeforeDiscovery);
    for (const target of targets) {
      const existing = uploadForTarget(state, target);
      if (existing?.sourceUri === target.sourceUri) continue;
      if (existing) continue;
      await options.service.prepare({
        ownerId: options.ownerId,
        domain: target.domain,
        sourceUri: target.sourceUri,
        persistPending: async (pending) => {
          state.uploads.push({
            target: {
              entity: target.entity,
              entityId: target.entityId,
              domain: target.domain,
              field: target.field,
              ...(target.index === undefined ? {} : { index: target.index }),
            },
            sourceUri: target.sourceUri,
            phase: 'prepared',
            pending,
          });
          await persist(state);
        },
      });
      if (!await stillCurrent(startedGeneration)) {
        return {
          status: 'superseded',
          uploaded,
          pending: state.uploads.length,
          cleanupPending: state.cleanups.length,
          stagedCleanupPending: state.stagedCleanups.length,
        };
      }
    }

    if (!await stillCurrent(startedGeneration)) {
      return {
        status: 'superseded',
        uploaded,
        pending: state.uploads.length,
        cleanupPending: state.cleanups.length,
        stagedCleanupPending: state.stagedCleanups.length,
      };
    }
    await options.onSourcesDurablyStaged?.();

    for (const job of [...state.uploads]) {
      if (job.phase !== 'prepared') continue;
      const status = await processUpload(state, job, published, startedGeneration);
      if (state.uploads.find(
        (candidate) => candidate.pending.mutationId === job.pending.mutationId,
      )?.phase === 'uploaded') uploaded += 1;
      if (status) {
        return {
          status,
          uploaded,
          pending: state.uploads.length,
          cleanupPending: state.cleanups.length,
          stagedCleanupPending: state.stagedCleanups.length,
        };
      }
    }

    return {
      status: state.uploads.length > 0 ? 'pending-publication' : 'idle',
      uploaded,
      pending: state.uploads.length,
      cleanupPending: state.cleanups.length,
      stagedCleanupPending: state.stagedCleanups.length,
    };
  };

  return {
    reconcile() {
      const startedGeneration = generation;
      const result = queue.then(() => run(startedGeneration));
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    invalidate() {
      generation += 1;
    },
    async whenIdle() {
      await queue;
    },
  };
}

export function isValidPersonalMediaSyncState(value: unknown, ownerId: string): boolean {
  if (!isRecord(value) || value.version !== 1) return false;
  if (
    !Array.isArray(value.uploads)
    || !Array.isArray(value.cleanups)
    || !Array.isArray(value.stagedCleanups)
  ) return false;
  return value.uploads.every((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.target) || !isRecord(candidate.pending)) {
      return false;
    }
    const pending = candidate.pending;
    const target = candidate.target;
    const validTarget = typeof target.entityId === 'string'
      && target.entityId.length > 0
      && (
        (
          target.entity === 'calendar-entry'
          && target.field === 'imageUri'
          && target.domain === 'calendar'
          && target.index === undefined
        )
        || (
          target.entity === 'calendar-entry'
          && target.field === 'diaryPhotos'
          && target.domain === 'diary'
          && Number.isSafeInteger(target.index)
          && Number(target.index) >= 0
        )
        || (
          target.entity === 'stamp'
          && target.field === 'imageUri'
          && target.domain === 'stamp'
          && target.index === undefined
        )
        || (
          target.entity === 'trip'
          && target.field === 'coverImageUri'
          && target.domain === 'trip'
          && target.index === undefined
        )
        || (
          target.entity === 'trip'
          && target.field === 'photos'
          && target.domain === 'trip'
          && Number.isSafeInteger(target.index)
          && Number(target.index) >= 0
        )
      );
    const parsedKey = typeof pending.objectKey === 'string'
      ? parsePersonalMediaObjectKey(pending.objectKey, ownerId)
      : null;
    return candidate.phase !== undefined
      && (candidate.phase === 'prepared' || candidate.phase === 'uploaded')
      && validTarget
      && isDevicePersonalMediaUri(candidate.sourceUri)
      && pending.ownerId === ownerId
      && pending.domain === target.domain
      && parsedKey?.domain === pending.domain
      && typeof pending.mutationId === 'string'
      && UUID_PATTERN.test(pending.mutationId)
      && isDurablePersonalMediaStagedUri(pending.stagedUri)
      && Number.isSafeInteger(pending.attempts)
      && Number(pending.attempts) >= 0;
  }) && value.cleanups.every((candidate) => isRecord(candidate)
    && typeof candidate.objectKey === 'string'
    && parsePersonalMediaObjectKey(candidate.objectKey, ownerId) !== null
    && typeof candidate.queuedAt === 'string')
    && value.stagedCleanups.every((candidate) => isRecord(candidate)
      && isDurablePersonalMediaStagedUri(candidate.stagedUri)
      && typeof candidate.afterMutationId === 'string'
      && UUID_PATTERN.test(candidate.afterMutationId));
}
