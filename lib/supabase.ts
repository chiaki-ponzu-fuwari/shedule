import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

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

/**
 * Web では localStorage を使う（AsyncStorage だけだとセッションが復元されないことがある）。
 * react-native の Platform はこのモジュール読み込み時点では未定義なことがあるため使わない。
 */
function isBrowserLocalStorageAvailable() {
  if (typeof window === 'undefined') return false;
  try {
    const ls = window.localStorage;
    return typeof ls !== 'undefined' && typeof ls.getItem === 'function';
  } catch {
    return false;
  }
}

const authStorage = {
  getItem: (key: string) => {
    if (isBrowserLocalStorageAvailable()) {
      try {
        return Promise.resolve(window.localStorage.getItem(key));
      } catch {
        return Promise.resolve(null);
      }
    }
    return AsyncStorage.getItem(key);
  },
  setItem: (key: string, value: string) => {
    if (isBrowserLocalStorageAvailable()) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* quota / private mode */
      }
      return Promise.resolve();
    }
    return AsyncStorage.setItem(key, value);
  },
  removeItem: (key: string) => {
    if (isBrowserLocalStorageAvailable()) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* */
      }
      return Promise.resolve();
    }
    return AsyncStorage.removeItem(key);
  },
};

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
      auth: {
        storage: authStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
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
