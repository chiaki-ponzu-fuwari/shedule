import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useGroupStore } from '../store/groupStore';

/**
 * 起動時に匿名ログインし、`auth.uid()` を groupStore に反映する。
 *
 * getSession() を直に叩くと初期化・ストレージ復元より先に走り、毎回 signInAnonymously して
 * 別ユーザーになることがある。INITIAL_SESSION（復元済みセッション）だけを信頼する。
 *
 * Supabase で Anonymous プロバイダーを有効にすること。
 */
export function useSupabaseAuth() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setAuthUserId = useGroupStore((s) => s.setAuthUserId);

  useEffect(() => {
    let cancelled = false;

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;

      if (event === 'INITIAL_SESSION') {
        if (session?.user?.id) {
          setAuthUserId(session.user.id);
          setReady(true);
          return;
        }
        supabase.auth.signInAnonymously().then(({ data, error: anonErr }) => {
          if (cancelled) return;
          if (anonErr) {
            setError(anonErr.message);
          } else if (data.session?.user?.id) {
            setAuthUserId(data.session.user.id);
          }
          setReady(true);
        });
        return;
      }

      if (session?.user?.id) {
        setAuthUserId(session.user.id);
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [setAuthUserId]);

  return { ready, error };
}
