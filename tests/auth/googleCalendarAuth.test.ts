import {
  GOOGLE_CALENDAR_SCOPES,
  createGoogleWebTokenStorage,
  revokeGoogleAuthorization,
} from '../../lib/googleCalendarAuth';

type StorageLike = {
  getItem: jest.Mock<string | null, [string]>;
  setItem: jest.Mock<void, [string, string]>;
  removeItem: jest.Mock<void, [string]>;
};

function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(seed));
  return {
    getItem: jest.fn((key) => values.get(key) ?? null),
    setItem: jest.fn((key, value) => { values.set(key, value); }),
    removeItem: jest.fn((key) => { values.delete(key); }),
  };
}

describe('Google Calendar OAuth safety', () => {
  test('uses primary-calendar event scopes without the all-calendars scope', () => {
    expect(GOOGLE_CALENDAR_SCOPES).toEqual([
      'openid',
      'profile',
      'email',
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/calendar.calendars.readonly',
    ]);
    expect(GOOGLE_CALENDAR_SCOPES).not.toContain(
      'https://www.googleapis.com/auth/calendar',
    );
  });

  test('verifies session storage and removes a legacy token only after migration succeeds', async () => {
    const session = memoryStorage();
    const legacy = memoryStorage({ google_access_token: 'legacy-token' });
    const storage = createGoogleWebTokenStorage({
      session,
      legacy,
      prefix: '@scheduleshare/secure/',
    });

    await expect(storage.getItem('google_access_token')).resolves.toBe('legacy-token');
    expect(session.getItem('@scheduleshare/secure/google_access_token')).toBe('legacy-token');
    expect(legacy.getItem('google_access_token')).toBeNull();
  });

  test('does not erase the legacy token when the verified migration write fails', async () => {
    const session = memoryStorage();
    const legacy = memoryStorage({ google_access_token: 'legacy-token' });
    session.setItem.mockImplementation(() => undefined);
    const storage = createGoogleWebTokenStorage({
      session,
      legacy,
      prefix: '@scheduleshare/secure/',
    });

    await expect(storage.getItem('google_access_token')).rejects.toThrow(/verification/i);
    expect(legacy.getItem('google_access_token')).toBe('legacy-token');
  });

  test('posts the token in the revocation body and never in the URL', async () => {
    const fetchMock = jest.fn(async (_input: string, _init?: RequestInit) => ({ ok: true }));
    const fetcher = fetchMock as unknown as typeof fetch;

    await revokeGoogleAuthorization('private-token', fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/revoke',
      expect.objectContaining({
        method: 'POST',
        body: 'token=private-token',
      }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('private-token');
  });

  test('returns a safe error without including provider response details', async () => {
    const fetcher = jest.fn(async () => ({ ok: false, status: 400 })) as unknown as typeof fetch;

    await expect(revokeGoogleAuthorization('secret', fetcher)).rejects.toThrow(
      'Google authorization revocation failed',
    );
  });
});
