import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { useGoogleSyncStore } from './googleSyncStore';
import {
  createGoogleWebTokenStorage,
  revokeGoogleAuthorization,
} from '../lib/googleCalendarAuth';

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
const WEB_TOKEN_PREFIX = '@scheduleshare/secure/';

/** Web: トークンは localStorage より sessionStorage（タブを閉じたら消える・XSS で盗まれても永続しにくい） */
const getWebTokenStorage = () => {
  if (typeof sessionStorage === 'undefined' || typeof localStorage === 'undefined') {
    throw new Error('Google token storage is unavailable');
  }
  return createGoogleWebTokenStorage({
    session: sessionStorage,
    legacy: localStorage,
    prefix: WEB_TOKEN_PREFIX,
  });
};

const secureSet = async (key: string, value: string) => {
  if (Platform.OS === 'web') {
    await getWebTokenStorage().setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
};

const secureGet = async (key: string): Promise<string | null> => {
  if (Platform.OS === 'web') {
    return getWebTokenStorage().getItem(key);
  }
  return SecureStore.getItemAsync(key);
};

const secureDel = async (key: string) => {
  if (Platform.OS === 'web') {
    await getWebTokenStorage().removeItem(key);
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
        try {
          await secureSet(SECURE_KEY_ACCESS, accessToken);
          if (refreshToken) {
            await secureSet(SECURE_KEY_REFRESH, refreshToken);
          } else {
            await secureDel(SECURE_KEY_REFRESH);
          }
          set({ isSignedIn: true, userEmail: email, userName: name, userPhoto: photo });
        } catch {
          await Promise.allSettled([
            secureDel(SECURE_KEY_ACCESS),
            secureDel(SECURE_KEY_REFRESH),
          ]);
          throw new Error('Google Calendar credentials could not be stored');
        }
      },

      signOut: async () => {
        let token: string | null = null;
        try {
          token = (await secureGet(SECURE_KEY_REFRESH)) ?? (await secureGet(SECURE_KEY_ACCESS));
        } catch {
          // Storage cleanup below still runs even when a browser blocks reads.
        }
        if (token) {
          try {
            await revokeGoogleAuthorization(token);
          } catch {
            // Disconnect locally even if Google is temporarily unreachable.
          }
        }
        await Promise.allSettled([
          secureDel(SECURE_KEY_ACCESS),
          secureDel(SECURE_KEY_REFRESH),
        ]);
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
