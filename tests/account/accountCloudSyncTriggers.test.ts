import {
  createAccountCloudSyncTriggerBinding,
  type AccountCloudSyncAppState,
  type AccountCloudSyncStoreSource,
} from '../../lib/account/accountCloudSyncTriggers';

describe('account cloud sync triggers', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('runs at startup and debounces bursts from all owner-backed stores', async () => {
    const listeners: Array<() => void> = [];
    const source: AccountCloudSyncStoreSource = {
      subscribe: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const reconcileAndFlush = jest.fn(async () => ({ status: 'completed' as const }));
    const noteLocalChange = jest.fn();
    const binding = createAccountCloudSyncTriggerBinding({
      producer: {
        reconcileAndFlush,
        isApplyingRemote: () => false,
        invalidate: jest.fn(),
        noteLocalChange,
      },
      stores: [source, source],
      appState: {
        currentState: 'active',
        addEventListener: () => ({ remove: () => undefined }),
      },
      debounceMs: 400,
    });

    await Promise.resolve();
    expect(reconcileAndFlush).toHaveBeenCalledTimes(1);
    listeners.forEach((listener) => listener());
    listeners.forEach((listener) => listener());
    expect(noteLocalChange).toHaveBeenCalledTimes(4);
    jest.advanceTimersByTime(399);
    expect(reconcileAndFlush).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(reconcileAndFlush).toHaveBeenCalledTimes(2);

    binding.stop();
  });

  test('reconciles immediately when returning active and ignores store writes during remote apply', async () => {
    let storeListener: (() => void) | null = null;
    let appStateListener: ((state: string) => void) | null = null;
    let applyingRemote = false;
    const appState: AccountCloudSyncAppState = {
      currentState: 'background',
      addEventListener: (_event, listener) => {
        appStateListener = listener;
        return { remove: () => undefined };
      },
    };
    const reconcileAndFlush = jest.fn(async () => ({ status: 'completed' as const }));
    const invalidate = jest.fn();
    const noteLocalChange = jest.fn();
    const binding = createAccountCloudSyncTriggerBinding({
      producer: {
        reconcileAndFlush,
        isApplyingRemote: () => applyingRemote,
        invalidate,
        noteLocalChange,
      },
      stores: [{
        subscribe: (listener) => {
          storeListener = listener;
          return () => undefined;
        },
      }],
      appState,
      debounceMs: 400,
    });
    await Promise.resolve();
    expect(reconcileAndFlush).toHaveBeenCalledTimes(1);

    applyingRemote = true;
    storeListener!();
    expect(noteLocalChange).not.toHaveBeenCalled();
    jest.advanceTimersByTime(400);
    expect(reconcileAndFlush).toHaveBeenCalledTimes(1);

    applyingRemote = false;
    appStateListener!('active');
    await Promise.resolve();
    expect(reconcileAndFlush).toHaveBeenCalledTimes(2);

    binding.stop();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  test('does not start or schedule cloud work after credential access is frozen', async () => {
    let appStateListener: ((state: string) => void) | null = null;
    let storeListener: (() => void) | null = null;
    let allowed = false;
    const reconcileAndFlush = jest.fn(async () => ({ status: 'completed' as const }));
    const binding = createAccountCloudSyncTriggerBinding({
      producer: {
        reconcileAndFlush,
        isApplyingRemote: () => false,
        invalidate: jest.fn(),
        noteLocalChange: jest.fn(),
      },
      stores: [{
        subscribe: (listener) => {
          storeListener = listener;
          return () => undefined;
        },
      }],
      appState: {
        currentState: 'background',
        addEventListener: (_event, listener) => {
          appStateListener = listener;
          return { remove: () => undefined };
        },
      },
      canRun: () => allowed,
      debounceMs: 0,
    });

    await Promise.resolve();
    appStateListener!('active');
    storeListener!();
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    expect(reconcileAndFlush).not.toHaveBeenCalled();

    allowed = true;
    appStateListener!('background');
    appStateListener!('active');
    await Promise.resolve();
    expect(reconcileAndFlush).toHaveBeenCalledTimes(1);
    binding.stop();
  });

  test('retries a temporary cloud failure after its durable backoff delay', async () => {
    const reconcileAndFlush = jest.fn()
      .mockResolvedValueOnce({
        status: 'completed',
        syncPhase: 'pending',
        retryDelayMs: 1_000,
      })
      .mockResolvedValueOnce({
        status: 'completed',
        syncPhase: 'synced',
        retryDelayMs: null,
      });
    const binding = createAccountCloudSyncTriggerBinding({
      producer: {
        reconcileAndFlush,
        isApplyingRemote: () => false,
        invalidate: jest.fn(),
        noteLocalChange: jest.fn(),
      },
      stores: [],
      appState: {
        currentState: 'active',
        addEventListener: () => ({ remove: () => undefined }),
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(reconcileAndFlush).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(999);
    expect(reconcileAndFlush).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(reconcileAndFlush).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(10_000);
    expect(reconcileAndFlush).toHaveBeenCalledTimes(2);
    binding.stop();
  });

  test('cancels a pending retry when the owner binding stops', async () => {
    const reconcileAndFlush = jest.fn(async () => ({
      status: 'completed',
      syncPhase: 'pending',
      retryDelayMs: 1_000,
    }));
    const binding = createAccountCloudSyncTriggerBinding({
      producer: {
        reconcileAndFlush,
        isApplyingRemote: () => false,
        invalidate: jest.fn(),
        noteLocalChange: jest.fn(),
      },
      stores: [],
      appState: {
        currentState: 'active',
        addEventListener: () => ({ remove: () => undefined }),
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    binding.stop();
    jest.advanceTimersByTime(1_000);
    expect(reconcileAndFlush).toHaveBeenCalledTimes(1);
  });
});
