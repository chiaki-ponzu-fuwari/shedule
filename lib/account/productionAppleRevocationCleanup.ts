import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAppleRevocationCleanupCoordinator } from './appleRevocationCleanup';
import { clearProductionDeletedAccount } from './productionAccountDeletionCleanup';

const coordinator = createAppleRevocationCleanupCoordinator({
  storage: AsyncStorage,
  cleanup: clearProductionDeletedAccount,
});

export function clearRevokedAppleAccountLocally(ownerId: string) {
  return coordinator.begin(ownerId);
}

export function recoverPendingAppleRevocationCleanup() {
  return coordinator.recover();
}
