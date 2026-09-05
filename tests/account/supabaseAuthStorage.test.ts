import {
  SECURE_AUTH_CHUNK_BYTES,
  createSupabaseAuthStorage,
  type LegacyStringStorage,
  type SecureStringStorage,
} from '../../lib/supabaseAuthStorage';

function storageFixture() {
  const secureValues = new Map<string, string>();
  const legacyValues = new Map<string, string>();
  let failSecureSet: ((key: string, value: string) => boolean) | null = null;
  let corruptSecureRead: ((key: string, value: string | null) => string | null) | null = null;

  const secureStore: SecureStringStorage = {
    getItemAsync: jest.fn(async (key) => {
      const value = secureValues.get(key) ?? null;
      return corruptSecureRead ? corruptSecureRead(key, value) : value;
    }),
    setItemAsync: jest.fn(async (key, value) => {
      if (failSecureSet?.(key, value)) throw new Error('simulated secure write failure');
      secureValues.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key) => {
      secureValues.delete(key);
    }),
  };
  const legacyStorage: LegacyStringStorage = {
    getItem: jest.fn(async (key) => legacyValues.get(key) ?? null),
    setItem: jest.fn(async (key, value) => {
      legacyValues.set(key, value);
    }),
    removeItem: jest.fn(async (key) => {
      legacyValues.delete(key);
    }),
  };

  return {
    secureStore,
    legacyStorage,
    secureValues,
    legacyValues,
    setSecureWriteFailure(predicate: ((key: string, value: string) => boolean) | null) {
      failSecureSet = predicate;
    },
    setCorruptSecureRead(mapper: ((key: string, value: string | null) => string | null) | null) {
      corruptSecureRead = mapper;
    },
  };
}

describe('native Supabase auth storage', () => {
  test('round-trips a session through SecureStore instead of legacy AsyncStorage', async () => {
    const fixture = storageFixture();
    const storage = createSupabaseAuthStorage({
      kind: 'native',
      secureStore: fixture.secureStore,
      legacyStorage: fixture.legacyStorage,
    });

    await storage.setItem('sb-project-auth-token', '{"access_token":"one"}');

    await expect(storage.getItem('sb-project-auth-token')).resolves.toBe(
      '{"access_token":"one"}',
    );
    expect(fixture.secureStore.setItemAsync).toHaveBeenCalled();
    expect(fixture.legacyStorage.setItem).not.toHaveBeenCalled();
  });

  test('splits large unicode sessions into values no larger than about 1.8KB', async () => {
    const fixture = storageFixture();
    const storage = createSupabaseAuthStorage({
      kind: 'native',
      secureStore: fixture.secureStore,
      legacyStorage: fixture.legacyStorage,
    });
    const largeSession = JSON.stringify({
      access_token: 'a'.repeat(5_000),
      user_metadata: '旅行✈️'.repeat(700),
    });

    await storage.setItem('large-session', largeSession);

    await expect(storage.getItem('large-session')).resolves.toBe(largeSession);
    const chunks = [...fixture.secureValues.entries()]
      .filter(([key]) => key.includes('.chunk.'))
      .map(([, value]) => value);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((value) => Buffer.byteLength(value, 'utf8'))))
      .toBeLessThanOrEqual(SECURE_AUTH_CHUNK_BYTES);
  });

  test('keeps the previous generation active when the final manifest switch fails', async () => {
    const fixture = storageFixture();
    const storage = createSupabaseAuthStorage({
      kind: 'native',
      secureStore: fixture.secureStore,
      legacyStorage: fixture.legacyStorage,
    });
    await storage.setItem('session', 'old-session');
    fixture.setSecureWriteFailure(
      (key, value) => key.endsWith('.active') && value.includes('"active":"b"'),
    );

    await expect(storage.setItem('session', 'new-session')).rejects.toThrow(
      'simulated secure write failure',
    );
    fixture.setSecureWriteFailure(null);

    await expect(storage.getItem('session')).resolves.toBe('old-session');
    await storage.removeItem('session');
    expect(
      [...fixture.secureValues.keys()].filter(
        (key) => key.includes('.slot-') || key.includes('.chunk.'),
      ),
    ).toEqual([]);
  });

  test('migrates a legacy AsyncStorage session only after verified secure round-trip', async () => {
    const fixture = storageFixture();
    fixture.legacyValues.set('session', 'legacy-session');
    const storage = createSupabaseAuthStorage({
      kind: 'native',
      secureStore: fixture.secureStore,
      legacyStorage: fixture.legacyStorage,
    });

    await expect(storage.getItem('session')).resolves.toBe('legacy-session');
    expect(fixture.legacyValues.has('session')).toBe(false);
    expect(fixture.legacyStorage.removeItem).toHaveBeenCalledWith('session');
    await expect(storage.getItem('session')).resolves.toBe('legacy-session');
  });

  test('does not delete a legacy session when secure verification fails', async () => {
    const fixture = storageFixture();
    fixture.legacyValues.set('session', 'legacy-session');
    let corrupted = false;
    fixture.setCorruptSecureRead((key, value) => {
      if (!corrupted && key.includes('.chunk.') && value !== null) {
        corrupted = true;
        return `${value}-corrupt`;
      }
      return value;
    });
    const storage = createSupabaseAuthStorage({
      kind: 'native',
      secureStore: fixture.secureStore,
      legacyStorage: fixture.legacyStorage,
    });

    await expect(storage.getItem('session')).rejects.toThrow(/verification/i);
    expect(fixture.legacyValues.get('session')).toBe('legacy-session');
    expect(fixture.legacyStorage.removeItem).not.toHaveBeenCalled();
  });

  test('removal hides the session first and cleans both generation slots', async () => {
    const fixture = storageFixture();
    fixture.legacyValues.set('session', 'stale-legacy');
    const storage = createSupabaseAuthStorage({
      kind: 'native',
      secureStore: fixture.secureStore,
      legacyStorage: fixture.legacyStorage,
    });
    await storage.setItem('session', 'generation-a');
    await storage.setItem('session', 'generation-b');

    await storage.removeItem('session');

    await expect(storage.getItem('session')).resolves.toBeNull();
    expect(fixture.legacyValues.has('session')).toBe(false);
    expect(
      [...fixture.secureValues.keys()].filter(
        (key) => key.includes('.slot-') || key.includes('.chunk.'),
      ),
    ).toEqual([]);
  });
});

test('web Supabase auth storage continues to use the supplied localStorage adapter', async () => {
  const fixture = storageFixture();
  const webValues = new Map<string, string>();
  const webStorage: LegacyStringStorage = {
    getItem: jest.fn(async (key) => webValues.get(key) ?? null),
    setItem: jest.fn(async (key, value) => {
      webValues.set(key, value);
    }),
    removeItem: jest.fn(async (key) => {
      webValues.delete(key);
    }),
  };
  const storage = createSupabaseAuthStorage({
    kind: 'web',
    webStorage,
  });

  await storage.setItem('session', 'web-session');
  await expect(storage.getItem('session')).resolves.toBe('web-session');
  await storage.removeItem('session');
  await expect(storage.getItem('session')).resolves.toBeNull();
  expect(webStorage.setItem).toHaveBeenCalledWith('session', 'web-session');
  expect(fixture.secureStore.setItemAsync).not.toHaveBeenCalled();
});
