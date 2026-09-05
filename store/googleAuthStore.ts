import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { useGoogleSyncStore } from './googleSyncStore';

interface GoogleAuthState {
  isSignedIn: boolean;
  userEmail: string | null;
  userName: string | null;
  userPhoto: string | null;
  // トークンはSecureStoreに保存（AsyncStorageには入れない）
  signIn: (email: string, name: string, photo: string | null, accessToken: string, refreshToken: string | null) => Promise<void>;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  setAccessToken: (token: string) => Promise<void>;
}

const SECURE_KEY_ACCESS = 'google_access_token';
const SECURE_KEY_REFRESH = 'google_refresh_token';

/** Web: トークンは localStorage より sessionStorage（タブを閉じたら消える・XSS で盗まれても永続しにくい） */
const WEB_TOKEN_PREFIX = '@scheduleshare/secure/';

const secureSet = async (key: string, value: string) => {
  if (Platform.OS === 'web') {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(WEB_TOKEN_PREFIX + key, value);
      }
      // 旧実装（平文キー）を残さない
      try {
        localStorage.removeItem(key);
      } catch {
        /* */
      }
    } catch {
      /* quota / private mode */
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
};

const secureGet = async (key: string): Promise<string | null> => {
  if (Platform.OS === 'web') {
    try {
      if (typeof sessionStorage === 'undefined') return null;
      const namespaced = WEB_TOKEN_PREFIX + key;
      let v = sessionStorage.getItem(namespaced);
      if (v) return v;
      const legacy = localStorage.getItem(key);
      if (legacy) {
        sessionStorage.setItem(namespaced, legacy);
        localStorage.removeItem(key);
        return legacy;
      }
    } catch {
      return null;
    }
    return null;
  }
  return SecureStore.getItemAsync(key);
};

const secureDel = async (key: string) => {
  if (Platform.OS === 'web') {
    try {
      sessionStorage?.removeItem(WEB_TOKEN_PREFIX + key);
    } catch {
      /* */
    }
    try {
      localStorage.removeItem(key);
    } catch {
      /* */
    }
    return;
  }
  await SecureStore.deleteItemAsync(key);
};

export const useGoogleAuthStore = create<GoogleAuthState>()(
  persist(
    (set, get) => ({
      isSignedIn: false,
      userEmail: null,
      userName: null,
      userPhoto: null,

      signIn: async (email, name, photo, accessToken, refreshToken) => {
        await secureSet(SECURE_KEY_ACCESS, accessToken);
        if (refreshToken) await secureSet(SECURE_KEY_REFRESH, refreshToken);
        set({ isSignedIn: true, userEmail: email, userName: name, userPhoto: photo });
      },

      signOut: async () => {
        await secureDel(SECURE_KEY_ACCESS);
        await secureDel(SECURE_KEY_REFRESH);
        useGoogleSyncStore.getState().clearCalendarListSyncToken();
        set({ isSignedIn: false, userEmail: null, userName: null, userPhoto: null });
      },

      getAccessToken: async () => {
        return secureGet(SECURE_KEY_ACCESS);
      },

      setAccessToken: async (token: string) => {
        await secureSet(SECURE_KEY_ACCESS, token);
      },
    }),
    {
      name: 'google-auth-storage',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        isSignedIn: state.isSignedIn,
        userEmail: state.userEmail,
        userName: state.userName,
        userPhoto: state.userPhoto,
      }),
    }
  )
);
