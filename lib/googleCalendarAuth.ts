export const GOOGLE_CALENDAR_SCOPES = [
  'openid',
  'profile',
  'email',
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/calendar.calendars.readonly',
] as const;

const GOOGLE_REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export interface BrowserTokenStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createGoogleWebTokenStorage({
  session,
  legacy,
  prefix,
}: {
  session: BrowserTokenStorageLike;
  legacy: BrowserTokenStorageLike;
  prefix: string;
}) {
  const sessionKey = (key: string) => `${prefix}${key}`;

  const setItem = async (key: string, value: string) => {
    const namespacedKey = sessionKey(key);
    session.setItem(namespacedKey, value);
    if (session.getItem(namespacedKey) !== value) {
      throw new Error('Google token storage write verification failed');
    }
  };

  const removeItem = async (key: string) => {
    const namespacedKey = sessionKey(key);
    session.removeItem(namespacedKey);
    if (session.getItem(namespacedKey) !== null) {
      throw new Error('Google token storage removal verification failed');
    }
    legacy.removeItem(key);
    if (legacy.getItem(key) !== null) {
      throw new Error('Legacy Google token removal verification failed');
    }
  };

  return {
    setItem,
    getItem: async (key: string) => {
      const current = session.getItem(sessionKey(key));
      if (current !== null) return current;

      const legacyValue = legacy.getItem(key);
      if (legacyValue === null) return null;
      await setItem(key, legacyValue);
      legacy.removeItem(key);
      if (legacy.getItem(key) !== null) {
        throw new Error('Legacy Google token removal verification failed');
      }
      return legacyValue;
    },
    removeItem,
  };
}

export async function revokeGoogleAuthorization(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(GOOGLE_REVOCATION_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(token)}`,
  });
  if (!response.ok) {
    throw new Error('Google authorization revocation failed');
  }
}
