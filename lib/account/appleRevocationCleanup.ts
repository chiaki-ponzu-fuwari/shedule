export const APPLE_REVOCATION_CLEANUP_MARKER_KEY =
  'recoto:apple-revocation-cleanup:v1';

export interface AppleRevocationCleanupStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface AppleRevocationCleanupMarker {
  version: 1;
  ownerId: string;
  createdAt: string;
}

type AppleRevocationCleanupResult =
  | { status: 'none' }
  | { status: 'pending' | 'cleared'; ownerId: string };

function validateOwnerId(value: string): string {
  const ownerId = value.trim();
  if (!ownerId || ownerId.includes(':')) {
    throw new Error('Apple revocation cleanup owner is invalid');
  }
  return ownerId;
}

function parseMarker(raw: string | null): AppleRevocationCleanupMarker | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Apple revocation cleanup marker is unreadable');
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Apple revocation cleanup marker is invalid');
  }
  const candidate = value as Partial<AppleRevocationCleanupMarker>;
  if (
    candidate.version !== 1
    || typeof candidate.ownerId !== 'string'
    || !candidate.ownerId.trim()
    || candidate.ownerId.includes(':')
    || typeof candidate.createdAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.createdAt))
  ) {
    throw new Error('Apple revocation cleanup marker is invalid');
  }
  return candidate as AppleRevocationCleanupMarker;
}

export function createAppleRevocationCleanupCoordinator({
  storage,
  cleanup,
  now = () => new Date(),
}: {
  storage: AppleRevocationCleanupStorage;
  cleanup(ownerId: string): Promise<{ complete: boolean; errors: string[] }>;
  now?: () => Date;
}) {
  let queue: Promise<void> = Promise.resolve();

  const exclusively = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const read = async () => parseMarker(
    await storage.getItem(APPLE_REVOCATION_CLEANUP_MARKER_KEY),
  );

  const persist = async (marker: AppleRevocationCleanupMarker) => {
    const serialized = JSON.stringify(marker);
    await storage.setItem(APPLE_REVOCATION_CLEANUP_MARKER_KEY, serialized);
    if (await storage.getItem(APPLE_REVOCATION_CLEANUP_MARKER_KEY) !== serialized) {
      throw new Error('Apple revocation cleanup marker could not be saved');
    }
  };

  const remove = async () => {
    await storage.removeItem(APPLE_REVOCATION_CLEANUP_MARKER_KEY);
    if (await storage.getItem(APPLE_REVOCATION_CLEANUP_MARKER_KEY) !== null) {
      throw new Error('Apple revocation cleanup marker could not be cleared');
    }
  };

  const finish = async (
    marker: AppleRevocationCleanupMarker,
  ): Promise<AppleRevocationCleanupResult> => {
    const result = await cleanup(marker.ownerId);
    if (!result.complete) return { status: 'pending', ownerId: marker.ownerId };
    await remove();
    return { status: 'cleared', ownerId: marker.ownerId };
  };

  return {
    begin(ownerIdInput: string): Promise<AppleRevocationCleanupResult> {
      return exclusively(async () => {
        const ownerId = validateOwnerId(ownerIdInput);
        const existing = await read();
        if (existing && existing.ownerId !== ownerId) {
          throw new Error('Apple revocation cleanup belongs to a different account');
        }
        const marker = existing ?? {
          version: 1 as const,
          ownerId,
          createdAt: now().toISOString(),
        };
        if (!existing) await persist(marker);
        return finish(marker);
      });
    },

    recover(): Promise<AppleRevocationCleanupResult> {
      return exclusively(async () => {
        const marker = await read();
        return marker ? finish(marker) : { status: 'none' };
      });
    },
  };
}
