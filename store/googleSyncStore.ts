import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type GoogleSyncMode = 'fromGoogle' | 'toGoogle' | 'both';

interface GoogleSyncState {
  mode: GoogleSyncMode;
  lastSyncedAt: string | null; // ISO文字列
  /** events.list の増分同期用（転送量削減） */
  calendarListSyncToken: string | null;
  setMode: (mode: GoogleSyncMode) => void;
  setLastSyncedAt: (iso: string) => void;
  setCalendarListSyncToken: (token: string | null) => void;
  clearCalendarListSyncToken: () => void;
}

export const useGoogleSyncStore = create<GoogleSyncState>()(
  persist(
    (set) => ({
      mode: 'fromGoogle',
      lastSyncedAt: null,
      calendarListSyncToken: null,
      setMode: (mode) => set({ mode }),
      setLastSyncedAt: (iso) => set({ lastSyncedAt: iso }),
      setCalendarListSyncToken: (token) => set({ calendarListSyncToken: token }),
      clearCalendarListSyncToken: () => set({ calendarListSyncToken: null }),
    }),
    {
      name: 'google-sync-settings',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
