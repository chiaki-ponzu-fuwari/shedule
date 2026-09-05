import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import {
  clearAccountTransitionMediaHandoff,
  readAccountTransitionMediaHandoffUris,
} from './accountBootstrapPersistence';
import {
  createPlatformMediaStaging,
  isDurablePersonalMediaStagedUri,
  type DurableMediaStaging,
} from './personalMedia';
import type { KeyValueStorage } from './namespacedStorage';
import {
  createPersonalMediaSyncPersistence,
  personalMediaSyncStorageKey,
} from './productionPersonalMedia';

export interface PersonalMediaLocalArtifactCleaner {
  /** Returns true only when the URI names an app-owned local artifact. */
  removeAndVerify(uri: string): Promise<boolean>;
}

function isFileWithinRoot(uri: string, root: string | null): boolean {
  if (!root) return false;
  try {
    const candidate = new URL(uri);
    const directory = new URL(root);
    const directoryPath = directory.pathname.endsWith('/')
      ? directory.pathname
      : `${directory.pathname}/`;
    return candidate.protocol === 'file:'
      && directory.protocol === 'file:'
      && candidate.host === directory.host
      && candidate.pathname.startsWith(directoryPath)
      && candidate.pathname.length > directoryPath.length
      && /\.(?:jpe?g|png|heic|heif|webp)$/i.test(candidate.pathname);
  } catch {
    return false;
  }
}

/** Deletes only RECOTO staging or cache artifacts; external picker content is untouched. */
export function createProductionPersonalMediaArtifactCleaner({
  staging,
}: {
  staging?: DurableMediaStaging;
} = {}): PersonalMediaLocalArtifactCleaner {
  return {
    async removeAndVerify(uri) {
      if (isDurablePersonalMediaStagedUri(uri as unknown)) {
        const durableStaging = staging ?? createPlatformMediaStaging();
        await durableStaging.remove(uri);
        if (await durableStaging.exists(uri)) {
          throw new Error('Staged personal media deletion could not be verified');
        }
        return true;
      }
      if (isFileWithinRoot(uri, FileSystem.cacheDirectory)) {
        await FileSystem.deleteAsync(uri, { idempotent: true });
        if ((await FileSystem.getInfoAsync(uri)).exists) {
          throw new Error('Cached personal media deletion could not be verified');
        }
        return true;
      }
      if (Platform.OS === 'web' && uri.startsWith('blob:')) {
        if (typeof globalThis.URL?.revokeObjectURL !== 'function') {
          throw new Error('Browser personal media cleanup is unavailable');
        }
        globalThis.URL.revokeObjectURL(uri);
        return true;
      }
      // content:// may name the user's photo library, and data: has no separate
      // physical artifact. Neither is safe or necessary to delete here.
      return false;
    },
  };
}

/**
 * Account-deletion boundary: physical local media is verified absent before
 * either durable pointer is removed. Any failure leaves both pointers retryable.
 */
export async function clearPersonalMediaForOwner({
  ownerId,
  storage,
  cleaner,
}: {
  ownerId: string;
  storage: KeyValueStorage;
  cleaner: PersonalMediaLocalArtifactCleaner;
}): Promise<{ removedArtifacts: number }> {
  const persistence = createPersonalMediaSyncPersistence({ storage });
  const state = await persistence.read(ownerId);
  const handoffUris = await readAccountTransitionMediaHandoffUris(storage, ownerId);
  const artifactUris = new Set([
    ...state.uploads.map((job) => job.pending.stagedUri),
    ...state.uploads.map((job) => job.sourceUri),
    ...state.stagedCleanups.map((job) => job.stagedUri),
    ...handoffUris,
  ]);

  let removedArtifacts = 0;
  for (const uri of artifactUris) {
    if (await cleaner.removeAndVerify(uri)) removedArtifacts += 1;
  }

  const syncKey = personalMediaSyncStorageKey(ownerId);
  await storage.removeItem(syncKey);
  if (await storage.getItem(syncKey) !== null) {
    throw new Error('Personal media sync state could not be cleared');
  }
  await clearAccountTransitionMediaHandoff(storage, ownerId);
  return { removedArtifacts };
}

/** Production wrapper consumed by account deletion cleanup. */
export function clearProductionPersonalMediaForOwner(ownerId: string) {
  return clearPersonalMediaForOwner({
    ownerId,
    storage: AsyncStorage,
    cleaner: createProductionPersonalMediaArtifactCleaner(),
  });
}
