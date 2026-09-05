import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { createAccountCloudSyncTriggerBinding } from '../lib/account/accountCloudSyncTriggers';
import { createProductionAccountBootstrapRuntime } from '../lib/account/accountBootstrapPersistence';
import {
  ACCOUNT_OUTBOX_MANAGED_ENTITIES,
  ACCOUNT_OUTBOX_TRIP_ENTITIES,
  createAccountOutboxProducer,
  findPendingPersonalMediaReferences,
  type AccountOutboxProducerResult,
} from '../lib/account/outboxProducer';
import { createAccountOutboxProducerPersistence } from '../lib/account/productionOutboxProducer';
import {
  createMediaAwareCloudSyncProducer,
  createProductionPersonalMediaRuntime,
} from '../lib/account/productionPersonalMediaRuntime';
import {
  createSupabaseCloudRepository,
  type SupabaseCloudClient,
} from '../lib/account/supabaseCloudRepository';
import { createPortableSnapshot } from '../lib/account/personalSnapshot';
import { CloudRepositoryError } from '../lib/account/cloudRepository';
import { isAuthFailure } from '../lib/account/syncEngine';
import { getSupabaseClient } from '../lib/supabase';
import { useAccountStore } from '../store/accountStore';
import { useCalendarStore } from '../store/calendarStore';
import { useLocaleStore } from '../store/localeStore';
import { useStampStore } from '../store/stampStore';
import { useTripStore } from '../store/tripStore';

const CLOUD_OFFLINE_MESSAGE =
  'クラウド保存に接続できませんでした。変更はこの端末に保存されています。';
const CLOUD_SYNC_ERROR =
  'クラウド保存を完了できませんでした。設定からもう一度お試しください。';

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

function currentSnapshot(ownerId: string) {
  return createPortableSnapshot(currentSnapshotInput(), ownerId);
}

function currentPendingMedia() {
  return findPendingPersonalMediaReferences(
    currentSnapshotInput() as unknown as ReturnType<typeof currentSnapshot>,
  );
}

function ownerCanUseCloud(ownerId: string) {
  const account = useAccountStore.getState();
  return account.mode === 'account-connected'
    && account.userId === ownerId
    && account.syncPhase !== 'reauth-required';
}

function publishResult(ownerId: string, result: AccountOutboxProducerResult) {
  if (result.status === 'superseded' || !ownerCanUseCloud(ownerId)) return;
  const account = useAccountStore.getState();
  if (result.syncPhase === 'synced' && result.syncedAt) {
    account.markSynced(result.syncedAt);
  } else if (result.syncPhase === 'reauth-required') {
    account.markReauthRequired();
  } else if (result.syncPhase === 'error') {
    account.markError(CLOUD_SYNC_ERROR);
  } else if (result.followUpRequired || result.mediaPending) {
    useAccountStore.setState({
      syncPhase: 'pending',
      connectivity: 'online',
      operation: 'idle',
      error: null,
    });
  } else {
    account.markOffline(CLOUD_OFFLINE_MESSAGE);
  }
}

function publishError(ownerId: string, error: unknown) {
  if (!ownerCanUseCloud(ownerId)) return;
  const account = useAccountStore.getState();
  if (isAuthFailure(error)) {
    account.markReauthRequired();
  } else if (error instanceof CloudRepositoryError && error.retryable) {
    account.markOffline(CLOUD_OFFLINE_MESSAGE);
  } else {
    account.markError(CLOUD_SYNC_ERROR);
  }
}

/** Keeps account-owned local edits backed up after the initial migration gate opens. */
export function useAccountCloudSync() {
  const mode = useAccountStore((state) => state.mode);
  const ownerId = useAccountStore((state) => state.userId);
  const credentialAllowsCloud = useAccountStore(
    (state) => state.syncPhase !== 'reauth-required',
  );
  const client = getSupabaseClient();

  useEffect(() => {
    if (mode !== 'account-connected' || !ownerId || !client || !credentialAllowsCloud) return;

    const runtime = createProductionAccountBootstrapRuntime();
    const persistence = createAccountOutboxProducerPersistence({
      storage: AsyncStorage,
      ownerStorage: runtime.ownerStorage,
      bootstrapPersistence: runtime.persistence,
    });
    let binding: ReturnType<typeof createAccountCloudSyncTriggerBinding> | null = null;
    const cloudProducer = createAccountOutboxProducer({
      ownerId,
      ownerStorage: runtime.ownerStorage,
      persistence,
      repository: createSupabaseCloudRepository(client as unknown as SupabaseCloudClient),
      readSnapshot: () => currentSnapshot(ownerId),
      readPendingMedia: currentPendingMedia,
      randomUUID: () => Crypto.randomUUID(),
      managedEntities: [
        ...ACCOUNT_OUTBOX_MANAGED_ENTITIES,
        ...ACCOUNT_OUTBOX_TRIP_ENTITIES,
      ],
      onSyncing: () => {
        if (ownerCanUseCloud(ownerId)) useAccountStore.getState().markSyncing();
      },
      onResult: (result) => {
        publishResult(ownerId, result);
        if (result.status === 'completed' && result.followUpRequired) binding?.schedule();
      },
    });
    const media = createProductionPersonalMediaRuntime({
      ownerId,
      ownerStorage: runtime.ownerStorage,
      storage: AsyncStorage,
      client,
      outboxPersistence: persistence,
      isCurrentOwner: async () => ownerCanUseCloud(ownerId),
    });
    const producer = createMediaAwareCloudSyncProducer({
      media,
      cloud: cloudProducer,
    });

    binding = createAccountCloudSyncTriggerBinding({
      producer,
      stores: [
        { subscribe: (listener) => useCalendarStore.subscribe(listener) },
        { subscribe: (listener) => useStampStore.subscribe(listener) },
        { subscribe: (listener) => useLocaleStore.subscribe(listener) },
        { subscribe: (listener) => useTripStore.subscribe(listener) },
      ],
      appState: {
        currentState: AppState.currentState,
        addEventListener: (_event, listener) => AppState.addEventListener(
          'change',
          listener as (state: AppStateStatus) => void,
        ),
      },
      canRun: () => ownerCanUseCloud(ownerId),
      onError: (error) => publishError(ownerId, error),
    });

    return () => binding?.stop();
  }, [client, credentialAllowsCloud, mode, ownerId]);
}
