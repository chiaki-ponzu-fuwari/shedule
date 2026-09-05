import { useEffect, useState } from 'react';
import { useCalendarStore } from '../store/calendarStore';
import { useGoogleAuthStore } from '../store/googleAuthStore';
import { useGoogleSyncStore } from '../store/googleSyncStore';
import { useGroupStore } from '../store/groupStore';
import { useLocaleStore } from '../store/localeStore';
import { useStampStore } from '../store/stampStore';

export interface PersistHydrationSource {
  persist: {
    hasHydrated: () => boolean;
    onFinishHydration: (listener: () => void) => () => void;
    rehydrate: () => void | Promise<void>;
  };
}

const persistedLocalStores: readonly PersistHydrationSource[] = [
  useCalendarStore,
  useStampStore,
  useLocaleStore,
  useGroupStore,
  useGoogleAuthStore,
  useGoogleSyncStore,
];

function haveAllStoresHydrated(stores: readonly PersistHydrationSource[]) {
  return stores.every((store) => store.persist.hasHydrated());
}

export function observeLocalStoreHydration(
  stores: readonly PersistHydrationSource[],
  onReady: () => void
) {
  let active = true;
  let ready = false;
  const markReady = () => {
    if (!active || ready) return;
    ready = true;
    onReady();
  };
  const markReadyWhenComplete = () => {
    if (haveAllStoresHydrated(stores)) markReady();
  };
  const unsubscribers = stores.map((store) =>
    store.persist.onFinishHydration(markReadyWhenComplete)
  );

  if (haveAllStoresHydrated(stores)) {
    markReady();
  } else {
    void Promise.allSettled(stores.map((store) => store.persist.rehydrate())).then(markReady);
  }

  return () => {
    active = false;
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  };
}

export function useLocalStoresHydrated() {
  const [hydrated, setHydrated] = useState(() => haveAllStoresHydrated(persistedLocalStores));

  useEffect(
    () => observeLocalStoreHydration(persistedLocalStores, () => setHydrated(true)),
    []
  );

  return hydrated;
}
