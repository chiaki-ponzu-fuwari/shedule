import { useCallback, useEffect, useState } from 'react';
import { useCalendarStore } from '../store/calendarStore';
import { useGoogleAuthStore } from '../store/googleAuthStore';
import { useGoogleSyncStore } from '../store/googleSyncStore';
import { useGroupStore } from '../store/groupStore';
import { useLocaleStore } from '../store/localeStore';
import { useStampStore } from '../store/stampStore';
import { useTripStore } from '../store/tripStore';

export interface PersistHydrationSource {
  persist: {
    hasHydrated: () => boolean;
    onFinishHydration: (listener: () => void) => () => void;
    rehydrate: () => void | Promise<void>;
  };
}

export const persistedLocalStores: readonly PersistHydrationSource[] = [
  useCalendarStore,
  useStampStore,
  useTripStore,
  useLocaleStore,
  useGroupStore,
  useGoogleAuthStore,
  useGoogleSyncStore,
];

export type LocalStoreHydrationFailure = 'failed' | 'incomplete' | 'timeout';
export type LocalStoreHydrationStatus = 'hydrating' | 'ready' | 'failed';

const LOCAL_STORE_HYDRATION_TIMEOUT_MS = 10_000;

function haveAllStoresHydrated(stores: readonly PersistHydrationSource[]) {
  return stores.every((store) => store.persist.hasHydrated());
}

export function observeLocalStoreHydration(
  stores: readonly PersistHydrationSource[],
  onReady: () => void,
  onFailure: (reason: LocalStoreHydrationFailure) => void,
  timeoutMs = LOCAL_STORE_HYDRATION_TIMEOUT_MS
) {
  let active = true;
  let ready = false;
  let failureReported = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const markReady = () => {
    if (!active || ready || !haveAllStoresHydrated(stores)) return false;
    ready = true;
    if (timeoutId) clearTimeout(timeoutId);
    onReady();
    return true;
  };

  const reportFailure = (reason: LocalStoreHydrationFailure) => {
    if (!active || ready || failureReported) return;
    failureReported = true;
    if (timeoutId) clearTimeout(timeoutId);
    onFailure(reason);
  };

  let unsubscribers: Array<() => void> = [];
  const cleanup = () => {
    active = false;
    if (timeoutId) clearTimeout(timeoutId);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    unsubscribers = [];
  };

  if (haveAllStoresHydrated(stores)) {
    markReady();
    return cleanup;
  }

  unsubscribers = stores.map((store) => store.persist.onFinishHydration(markReady));
  if (ready || markReady()) return cleanup;

  timeoutId = setTimeout(() => reportFailure('timeout'), timeoutMs);

  let rehydrations: Array<Promise<void>>;
  try {
    rehydrations = stores.map((store) => Promise.resolve(store.persist.rehydrate()));
  } catch {
    reportFailure('failed');
    return cleanup;
  }

  void Promise.allSettled(rehydrations).then((results) => {
    if (!active || ready || markReady()) return;
    reportFailure(results.some((result) => result.status === 'rejected') ? 'failed' : 'incomplete');
  });

  return cleanup;
}

export function useLocalStoresHydration(
  stores: readonly PersistHydrationSource[] = persistedLocalStores,
  timeoutMs = LOCAL_STORE_HYDRATION_TIMEOUT_MS
) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    status: LocalStoreHydrationStatus;
    failureReason: LocalStoreHydrationFailure | null;
  }>(() => ({
    status: haveAllStoresHydrated(stores) ? 'ready' : 'hydrating',
    failureReason: null,
  }));

  useEffect(() => {
    setState({ status: 'hydrating', failureReason: null });
    return observeLocalStoreHydration(
      stores,
      () => setState({ status: 'ready', failureReason: null }),
      (failureReason) => setState({ status: 'failed', failureReason }),
      timeoutMs
    );
  }, [attempt, stores, timeoutMs]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  return { ...state, retry };
}
