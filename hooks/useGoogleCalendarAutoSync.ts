import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import { useGoogleAuthStore } from '../store/googleAuthStore';
import { useGoogleSyncStore } from '../store/googleSyncStore';
import { runGoogleCalendarSync } from '../utils/runGoogleCalendarSync';
import { devWarn } from '../utils/devLog';

/** 手動同期の直後と被らないよう、自動同期の最小間隔（ms） */
const MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Googleにログイン済みのとき、アプリがバックグラウンドから前面に戻ったら
 * 一定間隔でカレンダーを静かに同期する（ボタン不要の補助）。
 * 完全なバックグラウンド常時同期ではない（OS・トークン・電池の制約）。
 */
export function useGoogleCalendarAutoSync() {
  const isSignedIn = useGoogleAuthStore((s) => s.isSignedIn);
  const lastAutoRunRef = useRef(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    if (!isSignedIn) return;

    const maybeSync = () => {
      const now = Date.now();
      if (now - lastAutoRunRef.current < MIN_INTERVAL_MS) return;

      const lastSyncedAt = useGoogleSyncStore.getState().lastSyncedAt;
      if (lastSyncedAt) {
        const prev = new Date(lastSyncedAt).getTime();
        if (now - prev < MIN_INTERVAL_MS) return;
      }

      lastAutoRunRef.current = now;
      void runGoogleCalendarSync({ silent: true }).then((r) => {
        if (!r.ok && r.needsReauth && Platform.OS !== 'web') {
          devWarn('Google auto-sync', r.error);
        }
      });
    };

    const onChange = (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (prev.match(/inactive|background/) && next === 'active') {
        maybeSync();
      }
    };

    const sub = AppState.addEventListener('change', onChange);

    let visHandler: (() => void) | undefined;
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      visHandler = () => {
        if (document.visibilityState === 'visible') maybeSync();
      };
      document.addEventListener('visibilitychange', visHandler);
    }

    return () => {
      sub.remove();
      if (Platform.OS === 'web' && typeof document !== 'undefined' && visHandler) {
        document.removeEventListener('visibilitychange', visHandler);
      }
    };
  }, [isSignedIn]);
}
