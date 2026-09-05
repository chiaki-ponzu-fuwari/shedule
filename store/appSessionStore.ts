import { create } from 'zustand';
import { decideInitialSession, type CloudAvailability, type IdentityMode } from '../lib/auth/sessionBootstrap';
import { requireSupabaseClient } from '../lib/supabase';
import { useGroupStore } from './groupStore';

type SessionUser = { id: string; is_anonymous?: boolean };
type GuestSessionReason = 'group-action' | 'account-link';

interface AppSessionState {
  identityMode: IdentityMode;
  cloudAvailability: CloudAvailability;
  userId: string | null;
  error: string | null;
  setObservedSession: (configured: boolean, user: SessionUser | null) => void;
  setCloudOffline: (message: string) => void;
  setCloudOnline: () => void;
  ensureGuestSession: (reason?: GuestSessionReason) => Promise<string>;
}

let guestSessionInFlight: Promise<string> | null = null;

const CLOUD_CONNECTION_ERROR =
  'クラウドに接続できませんでした。' +
  '個人の予定はそのまま利用できます。時間をおいて再度お試しください。';

function connectionError(detail?: string) {
  return new Error(detail ? `${CLOUD_CONNECTION_ERROR} (${detail})` : CLOUD_CONNECTION_ERROR);
}

export const useAppSessionStore = create<AppSessionState>((set, get) => ({
  identityMode: 'hydrating',
  cloudAvailability: 'unknown',
  userId: null,
  error: null,

  setObservedSession: (configured, user) => {
    const next = decideInitialSession({ configured, user });
    useGroupStore.getState().setAuthUserId(next.userId);
    set({ ...next, error: null });
  },

  setCloudOffline: (message) => {
    set({ cloudAvailability: 'offline', error: message });
  },

  setCloudOnline: () => {
    set({ cloudAvailability: 'online', error: null });
  },

  ensureGuestSession: (_reason = 'group-action') => {
    const current = get();
    if (current.userId && current.identityMode !== 'guest-local' && current.identityMode !== 'hydrating') {
      useGroupStore.getState().setAuthUserId(current.userId);
      return Promise.resolve(current.userId);
    }

    if (guestSessionInFlight) return guestSessionInFlight;

    const request = (async () => {
      let client;
      try {
        client = requireSupabaseClient();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({
          identityMode: 'guest-local',
          cloudAvailability: 'misconfigured',
          userId: null,
          error: message,
        });
        useGroupStore.getState().setAuthUserId(null);
        throw error;
      }

      try {
        const { data: restored, error: restoreError } = await client.auth.getSession();
        if (restoreError) throw connectionError(restoreError.message);

        let user = restored.session?.user as SessionUser | undefined;
        if (!user) {
          const { data, error } = await client.auth.signInAnonymously();
          if (error) throw connectionError(error.message);
          user = (data.session?.user ?? data.user) as SessionUser | undefined;
        }

        if (!user?.id) throw connectionError();

        const next = decideInitialSession({ configured: true, user });
        useGroupStore.getState().setAuthUserId(user.id);
        set({ ...next, error: null });
        return user.id;
      } catch (error) {
        const recoverable =
          error instanceof Error && error.message.startsWith(CLOUD_CONNECTION_ERROR)
            ? error
            : connectionError(error instanceof Error ? error.message : String(error));
        set({ cloudAvailability: 'offline', error: recoverable.message });
        throw recoverable;
      }
    })();

    guestSessionInFlight = request;
    const clearInFlight = () => {
      if (guestSessionInFlight === request) guestSessionInFlight = null;
    };
    request.then(clearInFlight, clearInFlight);
    return request;
  },
}));
