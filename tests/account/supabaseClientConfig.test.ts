const mockCreateClient = jest.fn(() => ({ auth: {} }));
const mockSecureValues = new Map<string, string>();
const mockSecureGet = jest.fn(async (key: string) => mockSecureValues.get(key) ?? null);
const mockSecureSet = jest.fn(async (key: string, value: string) => {
  mockSecureValues.set(key, value);
});
const mockSecureDelete = jest.fn(async (key: string) => {
  mockSecureValues.delete(key);
});
const mockLegacySet = jest.fn(async () => undefined);

jest.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: mockSecureGet,
  setItemAsync: mockSecureSet,
  deleteItemAsync: mockSecureDelete,
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: mockLegacySet,
    removeItem: jest.fn(async () => undefined),
  },
}));

describe('main Supabase auth client', () => {
  beforeEach(() => {
    jest.resetModules();
    mockCreateClient.mockClear();
    mockSecureValues.clear();
    mockSecureGet.mockClear();
    mockSecureSet.mockClear();
    mockSecureDelete.mockClear();
    mockLegacySet.mockClear();
  });

  test('uses PKCE and never auto-consumes unvalidated callback parameters', () => {
    const { getMainSupabaseAuthOptions } = require('../../lib/supabase') as typeof import('../../lib/supabase');

    expect(getMainSupabaseAuthOptions()).toEqual(
      expect.objectContaining({
        flowType: 'pkce',
        detectSessionInUrl: false,
      }),
    );
  });

  test('stores native Supabase sessions in chunked SecureStore, not AsyncStorage', async () => {
    const { getMainSupabaseAuthOptions } = require('../../lib/supabase') as typeof import('../../lib/supabase');
    const storage = getMainSupabaseAuthOptions().storage;

    await storage.setItem('sb-project-auth-token', JSON.stringify({
      access_token: 'access',
      refresh_token: 'refresh',
    }));

    expect(mockSecureSet).toHaveBeenCalled();
    expect(mockLegacySet).not.toHaveBeenCalled();
  });

  test('never persists Google provider credentials in the main Supabase session', async () => {
    const { getMainSupabaseAuthOptions } =
      require('../../lib/supabase') as typeof import('../../lib/supabase');
    const storage = getMainSupabaseAuthOptions().storage;

    await storage.setItem('sb-project-auth-token', JSON.stringify({
      currentSession: {
        access_token: 'supabase-access',
        refresh_token: 'supabase-refresh',
        provider_token: 'google-provider-token',
        provider_refresh_token: 'google-provider-refresh',
      },
    }));

    const persisted = await storage.getItem('sb-project-auth-token');
    expect(persisted).toContain('supabase-access');
    expect(persisted).toContain('supabase-refresh');
    expect(persisted).not.toContain('google-provider-token');
    expect(persisted).not.toContain('google-provider-refresh');
  });

  test('exposes the same verified sensitive storage for operation journals and deletion receipts', async () => {
    const { getAccountOperationStorage, getMainSupabaseAuthOptions } =
      require('../../lib/supabase') as typeof import('../../lib/supabase');
    const operationStorage = getAccountOperationStorage();

    expect(operationStorage).toBe(getMainSupabaseAuthOptions().storage);
    await operationStorage.setItem('recoto.account.deletion-receipt.v1', '{"phase":"requested"}');
    await expect(operationStorage.getItem('recoto.account.deletion-receipt.v1'))
      .resolves.toBe('{"phase":"requested"}');
    expect(mockSecureSet).toHaveBeenCalled();
    expect(mockLegacySet).not.toHaveBeenCalled();
  });

  test('propagates web localStorage read, write, and removal failures', async () => {
    const { createBrowserAuthStorage } = require('../../lib/supabase') as typeof import('../../lib/supabase');
    const denied = new Error('localStorage denied');
    const storage = createBrowserAuthStorage(() => ({
      getItem: () => { throw denied; },
      setItem: () => { throw denied; },
      removeItem: () => { throw denied; },
    }));

    await expect(storage.getItem('session')).rejects.toThrow('localStorage denied');
    await expect(storage.setItem('session', 'value')).rejects.toThrow('localStorage denied');
    await expect(storage.removeItem('session')).rejects.toThrow('localStorage denied');
  });

  test('rejects web storage writes or removals that cannot be read back', async () => {
    const { createBrowserAuthStorage } = require('../../lib/supabase') as typeof import('../../lib/supabase');
    let value: string | null = 'old-session';
    const ignoredWrites = createBrowserAuthStorage(() => ({
      getItem: () => value,
      setItem: () => undefined,
      removeItem: () => undefined,
    }));

    await expect(ignoredWrites.setItem('session', 'new-session')).rejects.toThrow(/verification/i);
    await expect(ignoredWrites.removeItem('session')).rejects.toThrow(/verification/i);

    const working = createBrowserAuthStorage(() => ({
      getItem: () => value,
      setItem: (_key, next) => { value = next; },
      removeItem: () => { value = null; },
    }));
    await expect(working.setItem('session', 'new-session')).resolves.toBeUndefined();
    await expect(working.removeItem('session')).resolves.toBeUndefined();
  });

  test('persists transient PKCE recovery without persisting Google provider tokens', async () => {
    const { createTransientSupabaseAuthClient } =
      require('../../lib/account/supabaseAuthGateway') as typeof import('../../lib/account/supabaseAuthGateway');
    const values = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => { values.set(key, value); },
      removeItem: async (key: string) => { values.delete(key); },
    };

    createTransientSupabaseAuthClient(
      'https://project.supabase.co',
      'anon-key',
      'isolated-auth-key',
      storage,
    );
    const options = (mockCreateClient.mock.calls as unknown[][]).at(-1)?.[2] as {
      auth: {
        persistSession: boolean;
        storage: typeof storage;
      };
    };
    expect(options.auth.persistSession).toBe(true);
    await options.auth.storage.setItem('isolated-auth-key', JSON.stringify({
      access_token: 'supabase-access',
      refresh_token: 'supabase-refresh',
      provider_token: 'google-provider-token',
      provider_refresh_token: 'google-provider-refresh',
    }));

    expect(values.get('isolated-auth-key')).toContain('supabase-access');
    expect(values.get('isolated-auth-key')).not.toContain('google-provider-token');
    expect(values.get('isolated-auth-key')).not.toContain('google-provider-refresh');
  });
});
