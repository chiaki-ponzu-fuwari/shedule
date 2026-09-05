import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { createProductionAccountBootstrapRuntime } from './accountBootstrapPersistence';
import {
  accountDeletionNeedsNativeNotificationCleanup,
  clearDeletedAccountLocally,
} from './accountDeletionCleanup';
import {
  getSupabaseClient,
  isSupabaseConfigured,
} from '../supabase';
import { getAccountOAuthOperationJournal } from '../../hooks/useAccountAuth';
import { useAccountStore } from '../../store/accountStore';
import { useAppSessionStore } from '../../store/appSessionStore';
import { useGoogleAuthStore } from '../../store/googleAuthStore';
import { useGroupStore } from '../../store/groupStore';
import { clearProductionPersonalMediaForOwner } from './productionPersonalMediaCleanup';

const INSTALLATION_ID_KEY = 'recoto:installation-id';

export async function clearProductionAccountOAuthOperations() {
  const journal = getAccountOAuthOperationJournal();
  const operation = await journal.read();
  if (operation) await journal.cancel(operation.operationId);
  if (await journal.read() !== null) {
    throw new Error('account authorization recovery data is still present');
  }
}

export async function clearProductionDeletedAccount(ownerId: string) {
  const runtime = createProductionAccountBootstrapRuntime();
  return clearDeletedAccountLocally({
    readInstallationId: async () => {
      const installationId = await AsyncStorage.getItem(INSTALLATION_ID_KEY);
      if (!installationId) throw new Error('installation identity is unavailable');
      return installationId;
    },
    listStorageKeys: () => AsyncStorage.getAllKeys(),
    removeStorageKeys: (keys) => AsyncStorage.multiRemove(keys),
    cancelNotifications: async () => {
      if (!accountDeletionNeedsNativeNotificationCleanup(Platform.OS)) return;
      await Notifications.cancelAllScheduledNotificationsAsync();
    },
    disconnectGoogleCalendar: () => useGoogleAuthStore.getState().signOut(),
    clearAuthSession: async () => {
      const client = getSupabaseClient();
      if (!client) return;
      const result = await client.auth.signOut({ scope: 'local' });
      const current = await client.auth.getSession();
      if (current.data.session) {
        throw new Error(result.error?.message ?? 'local account session is still present');
      }
    },
    clearAuthOperations: clearProductionAccountOAuthOperations,
    clearPersonalMedia: async (deletedOwnerId) => {
      await clearProductionPersonalMediaForOwner(deletedOwnerId);
    },
    resetGroupState: () => useGroupStore.getState().setAuthUserId(null),
    selectEmptyGuest: async () => {
      const guest = await runtime.owners.getInstallationGuestOwner();
      await runtime.owners.switchOwnerAndRehydrate(guest);
      await runtime.persistence.clearAccountBinding();
    },
    resetAccountState: () => {
      useAccountStore.getState().resetToGuest();
      // This deliberately does not create another anonymous account. A later
      // group action may opt in to doing so, while the personal app stays usable.
      useAppSessionStore.getState().setObservedSession(isSupabaseConfigured(), null);
    },
  }, ownerId);
}
