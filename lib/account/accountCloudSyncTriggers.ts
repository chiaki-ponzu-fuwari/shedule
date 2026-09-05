export interface AccountCloudSyncStoreSource {
  subscribe(listener: () => void): () => void;
}

export interface AccountCloudSyncAppState {
  currentState: string;
  addEventListener(
    event: 'change',
    listener: (state: string) => void,
  ): { remove(): void };
}

export interface AccountCloudSyncTriggerProducer {
  reconcileAndFlush(): Promise<{ retryDelayMs?: number | null } | unknown>;
  isApplyingRemote(): boolean;
  noteLocalChange(): void;
  invalidate(): void;
}

interface TriggerBindingOptions {
  producer: AccountCloudSyncTriggerProducer;
  stores: readonly AccountCloudSyncStoreSource[];
  appState: AccountCloudSyncAppState;
  debounceMs?: number;
  canRun?: () => boolean;
  onError?: (error: unknown) => void;
}

/** Binds process-lifetime triggers without importing React or native globals. */
export function createAccountCloudSyncTriggerBinding({
  producer,
  stores,
  appState,
  debounceMs = 400,
  canRun = () => true,
  onError,
}: TriggerBindingOptions) {
  let active = true;
  let previousAppState = appState.currentState;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let runSequence = 0;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const retryDelay = (result: unknown) => {
    if (!result || typeof result !== 'object') return null;
    const delay = (result as { retryDelayMs?: unknown }).retryDelayMs;
    return typeof delay === 'number' && Number.isFinite(delay) && delay >= 0
      ? delay
      : null;
  };

  const run = () => {
    if (!active || !canRun()) return;
    const sequence = ++runSequence;
    void producer.reconcileAndFlush().then((result) => {
      if (!active || sequence !== runSequence || !canRun()) return;
      clearRetry();
      const delay = retryDelay(result);
      if (delay === null) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        run();
      }, delay);
    }).catch((error) => {
      if (active && sequence === runSequence) onError?.(error);
    });
  };

  const runNow = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    clearRetry();
    run();
  };

  const schedule = () => {
    if (!active || !canRun() || producer.isApplyingRemote()) return;
    producer.noteLocalChange();
    if (timer !== null) clearTimeout(timer);
    clearRetry();
    timer = setTimeout(() => {
      timer = null;
      run();
    }, debounceMs);
  };

  const unsubscribers = stores.map((store) => store.subscribe(schedule));
  const appStateSubscription = appState.addEventListener('change', (nextState) => {
    const wasInactive = /inactive|background/.test(previousAppState);
    previousAppState = nextState;
    if (wasInactive && nextState === 'active') runNow();
  });

  // Startup reconciliation discovers edits persisted by Zustand before a prior
  // process was killed, then drains any already-durable mutations.
  run();

  return {
    schedule,
    stop() {
      if (!active) return;
      active = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      clearRetry();
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      appStateSubscription.remove();
      producer.invalidate();
    },
  };
}
