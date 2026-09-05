import type {
  MediaCleanupQueue,
  PersonalMediaDomain,
  PersonalMediaService,
} from './personalMedia';
import {
  isDurablePersonalMediaStagedUri,
  SIGNED_MEDIA_TTL_SECONDS,
} from './personalMedia';
import type { KeyValueStorage } from './namespacedStorage';
import {
  isDevicePersonalMediaUri,
  isValidPersonalMediaSyncState,
  parsePersonalMediaObjectKey,
  type PersonalMediaSyncPersistence,
  type PersonalMediaSyncState,
} from './personalMediaSync';

export const PERSONAL_MEDIA_SYNC_DOMAIN = 'personal-media-sync-v1';
const SAFE_OWNER_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireOwner(ownerId: string) {
  if (!SAFE_OWNER_PATTERN.test(ownerId)) throw new Error('Invalid personal media owner');
}

export function personalMediaSyncStorageKey(ownerId: string) {
  requireOwner(ownerId);
  return `recoto:user:${ownerId}:${PERSONAL_MEDIA_SYNC_DOMAIN}`;
}

function emptyState(): PersonalMediaSyncState {
  return { version: 1, uploads: [], cleanups: [], stagedCleanups: [] };
}

function parseState(raw: string | null, ownerId: string): PersonalMediaSyncState {
  if (raw === null) return emptyState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid personal media sync state');
  }
  if (!isValidPersonalMediaSyncState(parsed, ownerId)) {
    throw new Error('Invalid personal media sync state');
  }
  return clone(parsed as PersonalMediaSyncState);
}

export function createPersonalMediaSyncPersistence({
  storage,
}: {
  storage: KeyValueStorage;
}): PersonalMediaSyncPersistence {
  return {
    async read(ownerId) {
      return parseState(await storage.getItem(personalMediaSyncStorageKey(ownerId)), ownerId);
    },
    async write(ownerId, state) {
      requireOwner(ownerId);
      if (!isValidPersonalMediaSyncState(state, ownerId)) {
        throw new Error('Invalid personal media sync state');
      }
      const serialized = JSON.stringify(state);
      const key = personalMediaSyncStorageKey(ownerId);
      await storage.setItem(key, serialized);
      const verified = parseState(await storage.getItem(key), ownerId);
      if (JSON.stringify(verified) !== serialized) {
        throw new Error('Personal media sync state could not be verified');
      }
    },
  };
}

export function createPersonalMediaCleanupQueue({
  ownerId,
  persistence,
  now = () => new Date(),
}: {
  ownerId: string;
  persistence: PersonalMediaSyncPersistence;
  now?: () => Date;
}): MediaCleanupQueue {
  requireOwner(ownerId);
  let queue: Promise<void> = Promise.resolve();
  const mutate = (mutation: (state: PersonalMediaSyncState) => void) => {
    const result = queue.then(async () => {
      const state = await persistence.read(ownerId);
      mutation(state);
      await persistence.write(ownerId, state);
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    enqueue(objectKey) {
      if (!parsePersonalMediaObjectKey(objectKey, ownerId)) {
        return Promise.reject(new Error('Invalid personal media cleanup object key'));
      }
      return mutate((state) => {
        if (!state.cleanups.some((cleanup) => cleanup.objectKey === objectKey)) {
          state.cleanups.push({ objectKey, queuedAt: now().toISOString() });
        }
      });
    },
    complete(objectKey) {
      if (!parsePersonalMediaObjectKey(objectKey, ownerId)) {
        return Promise.reject(new Error('Invalid personal media cleanup object key'));
      }
      return mutate((state) => {
        state.cleanups = state.cleanups.filter((cleanup) => cleanup.objectKey !== objectKey);
      });
    },
    enqueueStagedFile(stagedUri, afterMutationId) {
      if (!isDurablePersonalMediaStagedUri(stagedUri) || !UUID_PATTERN.test(afterMutationId)) {
        return Promise.reject(new Error('Invalid staged personal media cleanup'));
      }
      return mutate((state) => {
        if (!state.stagedCleanups.some((cleanup) => (
          cleanup.stagedUri === stagedUri && cleanup.afterMutationId === afterMutationId
        ))) {
          state.stagedCleanups.push({ stagedUri, afterMutationId });
        }
      });
    },
    completeStagedFile(stagedUri) {
      if (!isDurablePersonalMediaStagedUri(stagedUri)) {
        return Promise.reject(new Error('Invalid staged personal media cleanup'));
      }
      return mutate((state) => {
        state.stagedCleanups = state.stagedCleanups.filter(
          (cleanup) => cleanup.stagedUri !== stagedUri,
        );
      });
    },
  };
}

interface SignedUrlCacheEntry {
  expiresAt: number;
  value: string;
}

/**
 * Resolves private object keys without ever accepting a URL from a cloud row.
 * Device and icon URIs are returned only for the current local runtime.
 */
export function createPersonalMediaReadUrlResolver({
  ownerId,
  createSignedReadUrl,
  now = () => Date.now(),
}: {
  ownerId: string;
  createSignedReadUrl: PersonalMediaService['createSignedReadUrl'];
  now?: () => number;
}) {
  requireOwner(ownerId);
  const cache = new Map<string, SignedUrlCacheEntry>();
  const inFlight = new Map<string, Promise<string>>();
  const cacheLifetimeMs = Math.max(1_000, (SIGNED_MEDIA_TTL_SECONDS - 120) * 1_000);

  return {
    async resolve(
      uri: string | undefined,
      expectedDomain?: PersonalMediaDomain | readonly PersonalMediaDomain[],
    ): Promise<string | undefined> {
      if (!uri) return undefined;
      if (uri.startsWith('icon://') || isDevicePersonalMediaUri(uri)) return uri;
      const parsed = parsePersonalMediaObjectKey(uri, ownerId);
      const allowedDomains = typeof expectedDomain === 'string'
        ? [expectedDomain]
        : expectedDomain;
      if (!parsed || (allowedDomains !== undefined && !allowedDomains.includes(parsed.domain))) {
        return undefined;
      }
      const cached = cache.get(uri);
      if (cached && cached.expiresAt > now()) return cached.value;
      const existing = inFlight.get(uri);
      if (existing) return existing;
      const request = createSignedReadUrl(ownerId, parsed.domain, uri)
        .then((value) => {
          cache.set(uri, { value, expiresAt: now() + cacheLifetimeMs });
          return value;
        })
        .finally(() => {
          inFlight.delete(uri);
        });
      inFlight.set(uri, request);
      return request;
    },
    clear() {
      cache.clear();
      inFlight.clear();
    },
  };
}
