import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import {
  createProviderTokenStrippingStorage,
  createSupabaseAuthStorage,
} from './supabaseAuthStorage';

const CONFIGURATION_ERROR_MESSAGE =
  'グループ機能の接続設定が完了していません。' +
  '個人の予定はそのまま利用できます。設定後にもう一度お試しください。';

let singleton: SupabaseClient | null = null;
let singletonConfigurationKey: string | null = null;

function readConfiguration() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? '';
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '';
  return { url, anonKey };
}

type BrowserStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Web keeps account credentials in same-origin localStorage. Storage failures
 * are deliberately observable: treating quota/private-mode failures as a
 * successful auth commit could lose the only resumable target session.
 */
export function createBrowserAuthStorage(
  resolveStorage: () => BrowserStorageLike = () => {
    if (typeof window === 'undefined' || !window.localStorage) {
      throw new Error('Web account storage is unavailable');
    }
    return window.localStorage;
  },
) {
  return {
    getItem: async (key: string) => resolveStorage().getItem(key),
    setItem: async (key: string, value: string) => {
      const storage = resolveStorage();
      storage.setItem(key, value);
      if (storage.getItem(key) !== value) {
        throw new Error('Web account storage write verification failed');
      }
    },
    removeItem: async (key: string) => {
      const storage = resolveStorage();
      storage.removeItem(key);
      if (storage.getItem(key) !== null) {
        throw new Error('Web account storage removal verification failed');
      }
    },
  };
}

const webAuthStorage = createBrowserAuthStorage();

const authStorage = createProviderTokenStrippingStorage(
  createSupabaseAuthStorage(
    Platform.OS === 'web'
      ? { kind: 'web', webStorage: webAuthStorage }
      : {
          kind: 'native',
          secureStore: SecureStore,
          // Existing releases stored Supabase sessions here. The secure adapter
          // deletes this value only after a verified SecureStore round-trip.
          legacyStorage: AsyncStorage,
        },
  ),
);

/**
 * Verified sensitive-string storage shared by auth journals and deletion
 * receipts. Callers must use distinct keys for each record type.
 */
export function getAccountOperationStorage() {
  return authStorage;
}

export function getMainSupabaseAuthOptions() {
  return {
    flowType: 'pkce' as const,
    storage: authStorage,
    persistSession: true,
    autoRefreshToken: true,
    // Account callbacks are accepted by the dedicated allow-listed route.
    detectSessionInUrl: false,
  };
}

/**
 * Supabase Auth（匿名ログイン）＋ RLS でアクセス制御します。
 *
 * ダッシュボードで「Authentication → Providers → Anonymous」を有効にし、
 * SQL エディタで supabase/migrations の RLS / RPC を適用してください。
 *
 * セキュリティ: anon キーはクライアント埋め込み前提。service_role は絶対に入れないこと。
 * Web 本番では XSS 対策（依存の更新・危ない HTML 混入の回避）と CSP 検討が有効。
 */
export function isSupabaseConfigured(): boolean {
  const { url, anonKey } = readConfiguration();
  return Boolean(url && anonKey);
}

export function getSupabaseClient(): SupabaseClient | null {
  const { url, anonKey } = readConfiguration();
  if (!url || !anonKey) return null;

  const configurationKey = `${url}\n${anonKey}`;
  if (singleton && singletonConfigurationKey === configurationKey) return singleton;

  try {
    singleton = createClient(url, anonKey, {
      auth: getMainSupabaseAuthOptions(),
    });
    singletonConfigurationKey = configurationKey;
    return singleton;
  } catch {
    singleton = null;
    singletonConfigurationKey = null;
    return null;
  }
}

export function requireSupabaseClient(): SupabaseClient {
  const client = getSupabaseClient();
  if (!client) throw new Error(CONFIGURATION_ERROR_MESSAGE);
  return client;
}
