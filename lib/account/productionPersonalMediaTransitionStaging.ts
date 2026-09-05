import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PersonalSnapshot } from '../../types/account';
import {
  createPersonalMediaPreparationService,
  createPlatformJpegProcessor,
  createPlatformMediaStaging,
} from './personalMedia';
import type { KeyValueStorage } from './namespacedStorage';
import { discoverPendingPersonalMediaTargets } from './personalMediaSync';
import {
  createPersonalMediaCleanupQueue,
  createPersonalMediaSyncPersistence,
} from './productionPersonalMedia';
import { createPersonalMediaTransitionStager } from './personalMediaTransitionStaging';

/** Stages guest picker bytes before bootstrap switches away from the guest owner. */
export function createProductionPersonalMediaTransitionStager({
  storage = AsyncStorage,
}: {
  storage?: KeyValueStorage;
} = {}) {
  const persistence = createPersonalMediaSyncPersistence({ storage });

  return {
    stage(ownerId: string, snapshot: PersonalSnapshot) {
      if (discoverPendingPersonalMediaTargets(snapshot).length === 0) {
        return Promise.resolve();
      }
      const service = createPersonalMediaPreparationService({
        processor: createPlatformJpegProcessor(),
        staging: createPlatformMediaStaging(),
        cleanupQueue: createPersonalMediaCleanupQueue({ ownerId, persistence }),
      });
      return createPersonalMediaTransitionStager({ persistence, service })
        .stage(ownerId, snapshot);
    },
  };
}
