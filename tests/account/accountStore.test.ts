import {
  initialAccountState,
  selectAccountBackupStatus,
  useAccountStore,
} from '../../store/accountStore';

describe('account backup UI state', () => {
  beforeEach(() => {
    useAccountStore.setState(initialAccountState);
  });

  test('starts as a usable local-only guest', () => {
    expect(selectAccountBackupStatus(useAccountStore.getState())).toBe('local-only');
    expect(useAccountStore.getState()).toMatchObject({
      mode: 'guest-local',
      syncPhase: 'local-only',
      provider: null,
      operation: 'idle',
    });
  });

  test('shows connecting before an account identity is confirmed', () => {
    useAccountStore.getState().beginConnection('google');

    expect(selectAccountBackupStatus(useAccountStore.getState())).toBe('connecting');
    expect(useAccountStore.getState()).toMatchObject({
      mode: 'guest-local',
      provider: 'google',
      operation: 'connecting',
    });
  });

  test('records a connected provider without treating sync as complete', () => {
    useAccountStore.getState().beginConnection('apple');
    useAccountStore.getState().markConnected({
      userId: 'user-1',
      provider: 'apple',
      email: 'private@privaterelay.appleid.com',
    });

    expect(selectAccountBackupStatus(useAccountStore.getState())).toBe('pending');
    expect(useAccountStore.getState()).toMatchObject({
      mode: 'account-connected',
      syncPhase: 'pending',
      userId: 'user-1',
      operation: 'idle',
    });
  });

  test('distinguishes syncing, synced, offline, reauth, and deletion states', () => {
    const store = useAccountStore.getState();
    store.markConnected({ userId: 'user-1', provider: 'google', email: null });
    store.markSyncing();
    expect(selectAccountBackupStatus(useAccountStore.getState())).toBe('syncing');

    store.markSynced('2026-09-05T12:34:00.000Z');
    expect(selectAccountBackupStatus(useAccountStore.getState())).toBe('synced');

    store.markOffline('通信を確認してください');
    expect(selectAccountBackupStatus(useAccountStore.getState())).toBe('offline');
    expect(useAccountStore.getState().lastSyncedAt).toBe('2026-09-05T12:34:00.000Z');

    store.markReauthRequired();
    expect(selectAccountBackupStatus(useAccountStore.getState())).toBe('reauth-required');

    store.markDeletionPending();
    expect(selectAccountBackupStatus(useAccountStore.getState())).toBe('deletion-pending');
  });

  test('cancellation returns to the prior stable state without an error', () => {
    useAccountStore.getState().beginConnection('google');
    useAccountStore.getState().cancelConnection();

    expect(useAccountStore.getState()).toMatchObject(initialAccountState);
    expect(selectAccountBackupStatus(useAccountStore.getState())).toBe('local-only');
  });

  test('returning to an anonymous session cannot retain the prior account identity', () => {
    useAccountStore.getState().markConnected({
      userId: 'private-user',
      provider: 'google',
      email: 'private@example.com',
    });

    useAccountStore.getState().setGuestConnected('anonymous-user');

    expect(useAccountStore.getState()).toMatchObject({
      mode: 'guest-connected',
      syncPhase: 'local-only',
      userId: 'anonymous-user',
      provider: null,
      email: null,
      lastSyncedAt: null,
    });
  });
});
