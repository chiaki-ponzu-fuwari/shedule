import { decideInitialSession, shouldCreateAnonymousSession } from '../../lib/auth/sessionBootstrap';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

describe('session bootstrap', () => {
  test('uses local guest mode when Supabase is not configured', () => {
    expect(decideInitialSession({ configured: false, user: null })).toEqual({
      identityMode: 'guest-local',
      cloudAvailability: 'misconfigured',
      userId: null,
    });
  });

  test('does not create an anonymous account during app launch', () => {
    expect(shouldCreateAnonymousSession('app-launch')).toBe(false);
  });

  test('creates an anonymous account only for a group action', () => {
    expect(shouldCreateAnonymousSession('group-action')).toBe(true);
  });
});

describe('Supabase configuration boundary', () => {
  const originalUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const originalAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    } else {
      process.env.EXPO_PUBLIC_SUPABASE_URL = originalUrl;
    }
    if (originalAnonKey === undefined) {
      delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    } else {
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = originalAnonKey;
    }
    jest.resetModules();
  });

  test('can be imported without configuration and exposes a recoverable guard', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    jest.resetModules();

    let boundary: typeof import('../../lib/supabase') | undefined;
    expect(() => {
      boundary = require('../../lib/supabase');
    }).not.toThrow();

    expect(boundary?.isSupabaseConfigured()).toBe(false);
    expect(boundary?.getSupabaseClient()).toBeNull();
    expect(() => boundary?.requireSupabaseClient()).toThrow(/個人の予定はそのまま利用できます/);
  });
});

describe('lazy guest session', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('../../lib/supabase');
    jest.dontMock('../../store/groupStore');
    jest.resetModules();
  });

  test('reuses a restored session without creating another anonymous user', async () => {
    const setAuthUserId = jest.fn();
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: { session: { user: { id: 'restored-user', is_anonymous: true } } },
          error: null,
        })),
        signInAnonymously: jest.fn(),
      },
    };

    jest.resetModules();
    jest.doMock('../../lib/supabase', () => ({
      requireSupabaseClient: () => client,
    }));
    jest.doMock('../../store/groupStore', () => ({
      useGroupStore: { getState: () => ({ setAuthUserId }) },
    }));

    const { useAppSessionStore } = require('../../store/appSessionStore') as typeof import('../../store/appSessionStore');
    const userId = await useAppSessionStore.getState().ensureGuestSession('group-action');

    expect(userId).toBe('restored-user');
    expect(client.auth.signInAnonymously).not.toHaveBeenCalled();
    expect(setAuthUserId).toHaveBeenCalledWith('restored-user');
    expect(useAppSessionStore.getState()).toMatchObject({
      identityMode: 'guest-connected',
      cloudAvailability: 'online',
      userId: 'restored-user',
    });
  });

  test('deduplicates concurrent anonymous sign-in requests', async () => {
    const setAuthUserId = jest.fn();
    let resolveSignIn!: (value: {
      data: { session: { user: { id: string; is_anonymous: boolean } } };
      error: null;
    }) => void;
    const signInPromise = new Promise<{
      data: { session: { user: { id: string; is_anonymous: boolean } } };
      error: null;
    }>((resolve) => {
      resolveSignIn = resolve;
    });
    const client = {
      auth: {
        getSession: jest.fn(async () => ({ data: { session: null }, error: null })),
        signInAnonymously: jest.fn(() => signInPromise),
      },
    };

    jest.resetModules();
    jest.doMock('../../lib/supabase', () => ({
      requireSupabaseClient: () => client,
    }));
    jest.doMock('../../store/groupStore', () => ({
      useGroupStore: { getState: () => ({ setAuthUserId }) },
    }));

    const { useAppSessionStore } = require('../../store/appSessionStore') as typeof import('../../store/appSessionStore');
    const first = useAppSessionStore.getState().ensureGuestSession('group-action');
    const second = useAppSessionStore.getState().ensureGuestSession('group-action');

    expect(first).toBe(second);
    await Promise.resolve();
    expect(client.auth.signInAnonymously).toHaveBeenCalledTimes(1);

    resolveSignIn({
      data: { session: { user: { id: 'new-guest', is_anonymous: true } } },
      error: null,
    });

    await expect(first).resolves.toBe('new-guest');
    await expect(second).resolves.toBe('new-guest');
    expect(setAuthUserId).toHaveBeenCalledWith('new-guest');
  });

  test('synchronizes the group cache before exposing a restored identity', () => {
    let appSessionStore: typeof import('../../store/appSessionStore').useAppSessionStore;
    const identityModesSeenByGroupStore: string[] = [];
    const setAuthUserId = jest.fn(() => {
      identityModesSeenByGroupStore.push(appSessionStore.getState().identityMode);
    });

    jest.resetModules();
    jest.doMock('../../lib/supabase', () => ({ requireSupabaseClient: jest.fn() }));
    jest.doMock('../../store/groupStore', () => ({
      useGroupStore: { getState: () => ({ setAuthUserId }) },
    }));

    appSessionStore = (
      require('../../store/appSessionStore') as typeof import('../../store/appSessionStore')
    ).useAppSessionStore;
    appSessionStore.getState().setObservedSession(true, {
      id: 'restored-user',
      is_anonymous: true,
    });

    expect(identityModesSeenByGroupStore).toEqual(['hydrating']);
    expect(appSessionStore.getState().identityMode).toBe('guest-connected');
  });
});

describe('group cloud entry points', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('../../lib/supabase');
    jest.dontMock('../../store/appSessionStore');
    jest.resetModules();
  });

  test('keeps automatic fetch local but connects for an explicit refresh', async () => {
    let groupStore: typeof import('../../store/groupStore').useGroupStore;
    const ensureGuestSession = jest.fn(async () => {
      groupStore.getState().setAuthUserId('group-guest');
      return 'group-guest';
    });
    const membershipEq = jest.fn(async () => ({ data: [], error: null }));
    const client = {
      from: jest.fn(() => ({
        select: jest.fn(() => ({ eq: membershipEq })),
      })),
    };

    jest.resetModules();
    jest.doMock('../../lib/supabase', () => ({
      getSupabaseClient: () => client,
      requireSupabaseClient: () => client,
      supabase: client,
    }));
    jest.doMock('../../store/appSessionStore', () => ({
      useAppSessionStore: { getState: () => ({ ensureGuestSession }) },
    }));

    groupStore = (require('../../store/groupStore') as typeof import('../../store/groupStore')).useGroupStore;

    await groupStore.getState().fetchGroups();
    expect(ensureGuestSession).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();

    await groupStore.getState().fetchGroups({ force: true });
    expect(ensureGuestSession).toHaveBeenCalledTimes(1);
    expect(client.from).toHaveBeenCalledWith('group_members');
  });

  test('reports an explicit refresh failure as a recoverable cloud error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let groupStore: typeof import('../../store/groupStore').useGroupStore;
    const setCloudOffline = jest.fn();
    const setCloudOnline = jest.fn();
    const ensureGuestSession = jest.fn(async () => {
      groupStore.getState().setAuthUserId('group-guest');
      return 'group-guest';
    });
    const membershipEq = jest
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } })
      .mockResolvedValueOnce({ data: [], error: null });
    const client = {
      from: jest.fn(() => ({
        select: jest.fn(() => ({ eq: membershipEq })),
      })),
    };

    jest.resetModules();
    jest.doMock('../../lib/supabase', () => ({
      getSupabaseClient: () => client,
      requireSupabaseClient: () => client,
    }));
    jest.doMock('../../store/appSessionStore', () => ({
      useAppSessionStore: {
        getState: () => ({ ensureGuestSession, setCloudOffline, setCloudOnline }),
      },
    }));

    groupStore = (require('../../store/groupStore') as typeof import('../../store/groupStore')).useGroupStore;

    await expect(groupStore.getState().fetchGroups({ force: true })).rejects.toThrow(
      /個人の予定はそのまま利用できます/
    );
    expect(setCloudOffline).toHaveBeenCalledWith(
      expect.stringContaining('個人の予定はそのまま利用できます')
    );

    await expect(groupStore.getState().fetchGroups({ force: true })).resolves.toBeUndefined();
    expect(setCloudOnline).toHaveBeenCalledTimes(1);
  });

  test('does not restore cached groups for another user after auth wins the hydration race', async () => {
    let resolveStorage!: (value: string) => void;

    jest.resetModules();
    const storage = (
      require('@react-native-async-storage/async-storage') as {
        default: { getItem: jest.Mock };
      }
    ).default;
    storage.getItem.mockImplementation(
      () => new Promise<string>((resolve) => {
        resolveStorage = resolve;
      })
    );
    jest.doMock('../../lib/supabase', () => ({
      getSupabaseClient: () => null,
      requireSupabaseClient: jest.fn(),
    }));
    jest.doMock('../../store/appSessionStore', () => ({
      useAppSessionStore: { getState: () => ({ ensureGuestSession: jest.fn() }) },
    }));

    const groupStore = (require('../../store/groupStore') as typeof import('../../store/groupStore')).useGroupStore;
    groupStore.getState().setAuthUserId('new-user');

    resolveStorage(
      JSON.stringify({
        state: {
          groups: [
            {
              id: 'old-group',
              name: 'Old group',
              color: '#000000',
              emoji: '👥',
              inviteCode: 'OLD123',
              sharedMemo: '',
              members: [],
              createdAt: '2026-09-05T00:00:00.000Z',
            },
          ],
          cachedUserId: 'old-user',
          myName: 'わたし',
          sharingSettings: {},
          groupIconUris: {},
        },
        version: 0,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(groupStore.getState().myUserId).toBe('new-user');
    expect(groupStore.getState().cachedUserId).toBe('new-user');
    expect(groupStore.getState().groups).toEqual([]);
  });

  test('keeps fire-and-forget memo and name edits from leaking rejected promises', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ensureGuestSession = jest.fn(async () => {
      throw new Error('グループ機能の接続設定が完了していません。');
    });

    jest.resetModules();
    jest.doMock('../../lib/supabase', () => ({
      getSupabaseClient: () => null,
      requireSupabaseClient: jest.fn(),
    }));
    jest.doMock('../../store/appSessionStore', () => ({
      useAppSessionStore: { getState: () => ({ ensureGuestSession }) },
    }));

    const groupStore = (require('../../store/groupStore') as typeof import('../../store/groupStore')).useGroupStore;

    await expect(groupStore.getState().updateSharedMemo('group-id', 'memo')).resolves.toBeUndefined();
    await expect(groupStore.getState().updateGroupName('group-id', 'name')).resolves.toBeUndefined();
  });
});

describe('Supabase auth observer', () => {
  afterEach(() => {
    jest.dontMock('react');
    jest.dontMock('../../lib/supabase');
    jest.dontMock('../../store/appSessionStore');
    jest.dontMock('../../store/groupStore');
    jest.resetModules();
  });

  test('accepts a restored null session without creating an anonymous user', async () => {
    const unsubscribe = jest.fn();
    const signInAnonymously = jest.fn(async () => ({ data: { session: null }, error: null }));
    const client = {
      auth: {
        onAuthStateChange: jest.fn((callback: (event: string, session: null) => void) => {
          callback('INITIAL_SESSION', null);
          return { data: { subscription: { unsubscribe } } };
        }),
        signInAnonymously,
      },
    };
    const setObservedSession = jest.fn();
    const setCloudOffline = jest.fn();
    const setAuthUserId = jest.fn();
    const setReady = jest.fn();
    const setError = jest.fn();
    let cleanup: (() => void) | undefined;
    let stateIndex = 0;

    jest.resetModules();
    jest.doMock('react', () => ({
      useState: (initial: unknown) => {
        const setter = stateIndex++ === 0 ? setReady : setError;
        return [initial, setter];
      },
      useEffect: (effect: () => void | (() => void)) => {
        cleanup = effect() ?? undefined;
      },
    }));
    jest.doMock('../../lib/supabase', () => ({
      getSupabaseClient: () => client,
      supabase: client,
    }));
    jest.doMock('../../store/appSessionStore', () => ({
      useAppSessionStore: (selector: (state: object) => unknown) =>
        selector({ setObservedSession, setCloudOffline }),
    }));
    jest.doMock('../../store/groupStore', () => ({
      useGroupStore: (selector: (state: object) => unknown) => selector({ setAuthUserId }),
    }));

    const { useSupabaseAuth } = require('../../hooks/useSupabaseAuth') as typeof import('../../hooks/useSupabaseAuth');
    useSupabaseAuth();

    await Promise.resolve();
    expect(setReady).toHaveBeenCalledWith(true);
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(setObservedSession).toHaveBeenCalledWith(true, null);

    cleanup?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

test('root layout observes auth without blocking local UI or requesting notification permission', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const source = fs.readFileSync('app/_layout.tsx', 'utf8');

  expect(source).toContain('useSupabaseAuth();');
  expect(source).not.toContain('requestNotificationPermission');
  expect(source).not.toMatch(/if\s*\(\s*!ready\s*\)/);
  expect(source).not.toMatch(/if\s*\(\s*error\s*\)/);
});

test('group screens connect only from explicit action handlers', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const groupsScreen = fs.readFileSync('app/(tabs)/groups.tsx', 'utf8');
  const joinScreen = fs.readFileSync('app/join/[code].tsx', 'utf8');

  expect(groupsScreen).toContain("ensureGuestSession('group-action')");
  expect(joinScreen).toContain("ensureGuestSession('group-action')");
  expect(groupsScreen).toContain("identityMode === 'hydrating' ? [] : groups");
  expect(groupsScreen).not.toMatch(/useEffect\(\(\)\s*=>\s*\{[^}]*ensureGuestSession/s);
  expect(joinScreen).not.toMatch(/useEffect\(\(\)\s*=>\s*\{[^}]*ensureGuestSession/s);
});
