import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '';

if (!url || !anonKey) {
  throw new Error(
    'Supabase の URL / キーが未設定です。プロジェクト直下に .env を作成し、' +
      'EXPO_PUBLIC_SUPABASE_URL と EXPO_PUBLIC_SUPABASE_ANON_KEY を設定してください（.env.example 参照）。'
  );
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
export const supabase = createClient(url, anonKey, {
  auth: {
    storage: authStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
