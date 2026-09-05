import { useEffect, useState } from 'react';
import { getSupabaseClient } from '../lib/supabase';
import { useAppSessionStore } from '../store/appSessionStore';

/**
 * 復元された Supabase セッションを監視する。
 * 起動時にセッションがなくても匿名ユーザーは作らず、グループ操作時にだけ接続する。
 */
export function useSupabaseAuth() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setObservedSession = useAppSessionStore((s) => s.setObservedSession);
  const setCloudOffline = useAppSessionStore((s) => s.setCloudOffline);

  useEffect(() => {
    let cancelled = false;
    const client = getSupabaseClient();

    if (!client) {
      setObservedSession(false, null);
      setError(null);
      setReady(true);
      return;
    }

    try {
      const { data: sub } = client.auth.onAuthStateChange((event, session) => {
        if (cancelled) return;

        setObservedSession(true, session?.user ?? null);
        setError(null);
        if (event === 'INITIAL_SESSION') {
          setReady(true);
        }
      });

      return () => {
        cancelled = true;
        sub.subscription.unsubscribe();
      };
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      const message =
        'クラウドのセッションを確認できませんでした。' +
        '個人の予定はそのまま利用できます。' +
        (detail ? ` (${detail})` : '');
      setObservedSession(true, null);
      setCloudOffline(message);
      setError(message);
      setReady(true);
    }

    return () => {
      cancelled = true;
    };
  }, [setCloudOffline, setObservedSession]);

  return { ready, error };
}
