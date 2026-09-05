import { create } from 'zustand';
import type { AccountMode, SyncPhase } from '../types/account';
import type { BackupIdentityProvider } from '../lib/account/connectBackupIdentity';

export type AccountOperation = 'idle' | 'connecting';
export type AccountConnectivity = 'online' | 'offline';
export type AccountBackupStatus =
  | 'local-only'
  | 'connecting'
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'reauth-required'
  | 'deletion-pending'
  | 'error';

export interface ConnectedAccountDetails {
  userId: string;
  provider: BackupIdentityProvider;
  email: string | null;
}

export interface AccountState {
  mode: AccountMode;
  syncPhase: SyncPhase;
  connectivity: AccountConnectivity;
  operation: AccountOperation;
  provider: BackupIdentityProvider | null;
  email: string | null;
  userId: string | null;
  lastSyncedAt: string | null;
  error: string | null;
}

interface AccountActions {
  setGuestConnected(userId: string): void;
  beginConnection(provider: BackupIdentityProvider): void;
  cancelConnection(): void;
  markConnected(details: ConnectedAccountDetails): void;
  markSyncing(): void;
  markSynced(at: string): void;
  markConflictBackedUp(at: string): void;
  markOffline(message: string): void;
  markReauthRequired(message?: string): void;
  markError(message: string): void;
  markDeletionPending(): void;
  resetToGuest(): void;
}

export type AccountStore = AccountState & AccountActions;

export const initialAccountState: AccountState = {
  mode: 'guest-local',
  syncPhase: 'local-only',
  connectivity: 'online',
  operation: 'idle',
  provider: null,
  email: null,
  userId: null,
  lastSyncedAt: null,
  error: null,
};

export function selectAccountBackupStatus(state: AccountState): AccountBackupStatus {
  if (state.mode === 'deletion-pending') return 'deletion-pending';
  if (state.operation === 'connecting') return 'connecting';
  if (state.connectivity === 'offline') return 'offline';
  if (state.syncPhase === 'reauth-required') return 'reauth-required';
  if (state.syncPhase === 'syncing') return 'syncing';
  if (state.syncPhase === 'synced') return 'synced';
  if (state.syncPhase === 'pending' || state.syncPhase === 'conflict-backed-up') return 'pending';
  if (state.syncPhase === 'error') return 'error';
  return 'local-only';
}

export const useAccountStore = create<AccountStore>((set) => ({
  ...initialAccountState,

  setGuestConnected: (userId) =>
    set({
      ...initialAccountState,
      mode: 'guest-connected',
      userId,
      connectivity: 'online',
      error: null,
    }),

  beginConnection: (provider) =>
    set({ operation: 'connecting', provider, connectivity: 'online', error: null }),

  cancelConnection: () =>
    set((state) => ({
      operation: 'idle',
      provider: state.mode === 'account-connected' ? state.provider : null,
      error: null,
    })),

  markConnected: ({ userId, provider, email }) =>
    set({
      mode: 'account-connected',
      syncPhase: 'pending',
      connectivity: 'online',
      operation: 'idle',
      provider,
      email,
      userId,
      error: null,
    }),

  markSyncing: () =>
    set({ syncPhase: 'syncing', connectivity: 'online', operation: 'idle', error: null }),

  markSynced: (lastSyncedAt) =>
    set({
      syncPhase: 'synced',
      connectivity: 'online',
      operation: 'idle',
      lastSyncedAt,
      error: null,
    }),

  markConflictBackedUp: (lastSyncedAt) =>
    set({
      syncPhase: 'conflict-backed-up',
      connectivity: 'online',
      operation: 'idle',
      lastSyncedAt,
      error: null,
    }),

  markOffline: (error) =>
    set({ connectivity: 'offline', operation: 'idle', error }),

  markReauthRequired: (error = 'クラウド保存を続けるには再ログインが必要です。') =>
    set({
      syncPhase: 'reauth-required',
      connectivity: 'online',
      operation: 'idle',
      error,
    }),

  markError: (error) =>
    set({ syncPhase: 'error', connectivity: 'online', operation: 'idle', error }),

  markDeletionPending: () =>
    set({ mode: 'deletion-pending', operation: 'idle', error: null }),

  resetToGuest: () => set(initialAccountState),
}));
