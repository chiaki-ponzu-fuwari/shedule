jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const oldGroup = {
  id: 'old-group',
  name: 'Old name',
  color: '#111111',
  emoji: '👥',
  inviteCode: 'OLD123',
  sharedMemo: 'old memo',
  members: [{ id: 'user-a', name: 'A', color: '#111111', isOwner: true }],
  createdAt: '2026-09-05T00:00:00.000Z',
};

const userBGroup = {
  ...oldGroup,
  id: 'user-b-group',
  name: 'User B group',
  inviteCode: 'USERB1',
  members: [{ id: 'user-b', name: 'B', color: '#222222', isOwner: true }],
};

function mockGroupStoreDependencies(client: object, userId = 'user-a') {
  const sessionState = {
    ensureGuestSession: jest.fn(async () => userId),
    setCloudOffline: jest.fn(),
    setCloudError: jest.fn(),
    setCloudOnline: jest.fn(),
  };
  jest.doMock('../lib/supabase', () => ({
    getSupabaseClient: () => client,
    requireSupabaseClient: () => client,
  }));
  jest.doMock('../store/appSessionStore', () => ({
    useAppSessionStore: { getState: () => sessionState },
  }));
  return sessionState;
}

describe('lazy guest auth generation', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('../lib/supabase');
    jest.dontMock('../store/groupStore');
    jest.resetModules();
  });

  test('does not let a late anonymous result replace a newly observed account', async () => {
    const anonymousSignIn = deferred<{
      data: { session: { user: { id: string; is_anonymous: boolean } } };
      error: null;
    }>();
    const setAuthUserId = jest.fn();
    const client = {
      auth: {
        getSession: jest.fn(async () => ({ data: { session: null }, error: null })),
        signInAnonymously: jest.fn(() => anonymousSignIn.promise),
      },
    };

    jest.resetModules();
    jest.doMock('../lib/supabase', () => ({ requireSupabaseClient: () => client }));
    jest.doMock('../store/groupStore', () => ({
      useGroupStore: { getState: () => ({ setAuthUserId }) },
    }));
    const { useAppSessionStore } =
      require('../store/appSessionStore') as typeof import('../store/appSessionStore');

    const request = useAppSessionStore.getState().ensureGuestSession('group-action');
    await flushPromises();
    expect(client.auth.signInAnonymously).toHaveBeenCalledTimes(1);

    useAppSessionStore.getState().setObservedSession(true, {
      id: 'linked-account',
      is_anonymous: false,
    });
    anonymousSignIn.resolve({
      data: { session: { user: { id: 'late-guest', is_anonymous: true } } },
      error: null,
    });

    await expect(request).resolves.toBe('linked-account');
    expect(useAppSessionStore.getState()).toMatchObject({
      identityMode: 'account-connected',
      userId: 'linked-account',
    });
    expect(setAuthUserId).toHaveBeenCalledTimes(1);
    expect(setAuthUserId).toHaveBeenCalledWith('linked-account');
  });

  test('reuses an observed event for the same anonymous user', async () => {
    const anonymousSignIn = deferred<{
      data: { session: { user: { id: string; is_anonymous: boolean } } };
      error: null;
    }>();
    const setAuthUserId = jest.fn();
    const client = {
      auth: {
        getSession: jest.fn(async () => ({ data: { session: null }, error: null })),
        signInAnonymously: jest.fn(() => anonymousSignIn.promise),
      },
    };

    jest.resetModules();
    jest.doMock('../lib/supabase', () => ({ requireSupabaseClient: () => client }));
    jest.doMock('../store/groupStore', () => ({
      useGroupStore: { getState: () => ({ setAuthUserId }) },
    }));
    const { useAppSessionStore } =
      require('../store/appSessionStore') as typeof import('../store/appSessionStore');

    const request = useAppSessionStore.getState().ensureGuestSession('group-action');
    await flushPromises();
    useAppSessionStore.getState().setObservedSession(true, {
      id: 'same-guest',
      is_anonymous: true,
    });
    anonymousSignIn.resolve({
      data: { session: { user: { id: 'same-guest', is_anonymous: true } } },
      error: null,
    });

    await expect(request).resolves.toBe('same-guest');
    expect(useAppSessionStore.getState()).toMatchObject({
      identityMode: 'guest-connected',
      userId: 'same-guest',
    });
    expect(setAuthUserId).toHaveBeenCalledTimes(1);
  });

  test('continues guest sign-in when the initial observer event has no identity', async () => {
    const anonymousSignIn = deferred<{
      data: { session: { user: { id: string; is_anonymous: boolean } } };
      error: null;
    }>();
    const setAuthUserId = jest.fn();
    const client = {
      auth: {
        getSession: jest.fn(async () => ({ data: { session: null }, error: null })),
        signInAnonymously: jest.fn(() => anonymousSignIn.promise),
      },
    };

    jest.resetModules();
    jest.doMock('../lib/supabase', () => ({ requireSupabaseClient: () => client }));
    jest.doMock('../store/groupStore', () => ({
      useGroupStore: { getState: () => ({ setAuthUserId }) },
    }));
    const { useAppSessionStore } =
      require('../store/appSessionStore') as typeof import('../store/appSessionStore');

    const request = useAppSessionStore.getState().ensureGuestSession('group-action');
    await flushPromises();
    useAppSessionStore.getState().setObservedSession(true, null);
    anonymousSignIn.resolve({
      data: { session: { user: { id: 'new-guest', is_anonymous: true } } },
      error: null,
    });

    await expect(request).resolves.toBe('new-guest');
    expect(useAppSessionStore.getState()).toMatchObject({
      identityMode: 'guest-connected',
      userId: 'new-guest',
    });
    expect(setAuthUserId).toHaveBeenLastCalledWith('new-guest');
  });
});

describe('group async generations', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('../lib/supabase');
    jest.dontMock('../store/appSessionStore');
    jest.resetModules();
  });

  test('discards a fetch response owned by the previous authenticated user', async () => {
    const memberships = deferred<{ data: never[]; error: null }>();
    const client = {
      from: jest.fn(() => ({
        select: jest.fn(() => ({ eq: jest.fn(() => memberships.promise) })),
      })),
    };
    mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');

    const request = useGroupStore.getState().fetchGroups({ force: true });
    await flushPromises();
    useGroupStore.getState().setAuthUserId('user-b');
    useGroupStore.setState({ groups: [userBGroup], cachedUserId: 'user-b' });
    memberships.resolve({ data: [], error: null });
    await request.catch(() => undefined);

    expect(useGroupStore.getState().groups).toEqual([userBGroup]);
    expect(useGroupStore.getState().cachedUserId).toBe('user-b');
  });

  test('keeps a create result when an older fetch completes afterward', async () => {
    const memberships = deferred<{ data: never[]; error: null }>();
    const createdRow = {
      id: 'created-group',
      name: 'Created',
      color: '#abcdef',
      emoji: '✨',
      invite_code: 'NEW123',
      shared_memo: null,
      created_at: '2026-09-05T01:00:00.000Z',
    };
    const client = {
      rpc: jest.fn(() => ({
        single: jest.fn(async () => ({ data: createdRow, error: null })),
      })),
      from: jest.fn(() => ({
        select: jest.fn(() => ({ eq: jest.fn(() => memberships.promise) })),
      })),
    };
    mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');

    const oldFetch = useGroupStore.getState().fetchGroups({ force: true });
    await flushPromises();
    await useGroupStore.getState().createGroup('Created', '#abcdef', '✨');
    expect(useGroupStore.getState().groups.map((group) => group.id)).toEqual(['created-group']);

    memberships.resolve({ data: [], error: null });
    await oldFetch;
    expect(useGroupStore.getState().groups.map((group) => group.id)).toEqual(['created-group']);
  });

  test('only the latest groups fetch may replace the list', async () => {
    const firstMemberships = deferred<{ data: never[]; error: null }>();
    const secondMemberships = deferred<{
      data: { group_id: string }[];
      error: null;
    }>();
    const membershipEq = jest
      .fn()
      .mockImplementationOnce(() => firstMemberships.promise)
      .mockImplementationOnce(() => secondMemberships.promise);
    const groupRow = {
      id: 'latest-group',
      name: 'Latest',
      color: '#333333',
      emoji: '👥',
      invite_code: 'LATEST',
      shared_memo: '',
      created_at: '2026-09-05T02:00:00.000Z',
    };
    const client = {
      from: jest.fn((table: string) => ({
        select: jest.fn((columns: string) => {
          if (table === 'group_members' && columns === 'group_id') {
            return { eq: membershipEq };
          }
          return {
            in: jest.fn(async () => ({
              data:
                table === 'groups'
                  ? [groupRow]
                  : [
                      {
                        group_id: 'latest-group',
                        user_id: 'user-a',
                        user_name: 'A',
                        color: '#333333',
                        is_owner: true,
                      },
                    ],
              error: null,
            })),
          };
        }),
      })),
    };
    mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');

    const first = useGroupStore.getState().fetchGroups({ force: true });
    const second = useGroupStore.getState().fetchGroups({ force: true });
    await flushPromises();
    secondMemberships.resolve({ data: [{ group_id: 'latest-group' }], error: null });
    await second;
    expect(useGroupStore.getState().groups.map((group) => group.id)).toEqual(['latest-group']);

    firstMemberships.resolve({ data: [], error: null });
    await first;
    expect(useGroupStore.getState().groups.map((group) => group.id)).toEqual(['latest-group']);
  });

  test('does not commit a create response after the authenticated user changes', async () => {
    const createdRow = {
      id: 'user-a-created',
      name: 'A group',
      color: '#abcdef',
      emoji: '✨',
      invite_code: 'AAAAAA',
      shared_memo: null,
      created_at: '2026-09-05T03:00:00.000Z',
    };
    const rpcResult = deferred<{ data: typeof createdRow; error: null }>();
    const client = {
      rpc: jest.fn(() => ({ single: jest.fn(() => rpcResult.promise) })),
    };
    mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');

    const request = useGroupStore.getState().createGroup('A group', '#abcdef', '✨');
    await flushPromises();
    useGroupStore.getState().setAuthUserId('user-b');
    useGroupStore.setState({ groups: [userBGroup], cachedUserId: 'user-b' });
    rpcResult.resolve({ data: createdRow, error: null });

    await expect(request).rejects.toThrow(/認証状態が変更/);
    expect(useGroupStore.getState().groups).toEqual([userBGroup]);
    expect(useGroupStore.getState().cachedUserId).toBe('user-b');
  });

  test('does not continue a delayed join after the authenticated user changes', async () => {
    const joinedRow = {
      id: 'user-a-joined',
      name: 'A joined group',
      color: '#abcdef',
      emoji: '👥',
      invite_code: 'JOINED',
      shared_memo: null,
      created_at: '2026-09-05T04:00:00.000Z',
    };
    const rpcResult = deferred<{ data: typeof joinedRow; error: null }>();
    const client = {
      rpc: jest.fn(() => ({ maybeSingle: jest.fn(() => rpcResult.promise) })),
      from: jest.fn(),
    };
    const sessionState = mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');

    const request = useGroupStore.getState().joinGroupByCode('JOINED');
    await flushPromises();
    useGroupStore.getState().setAuthUserId('user-b');
    useGroupStore.setState({ groups: [userBGroup], cachedUserId: 'user-b' });
    rpcResult.resolve({ data: joinedRow, error: null });

    await expect(request).rejects.toThrow(/認証状態が変更/);
    expect(client.from).not.toHaveBeenCalled();
    expect(useGroupStore.getState().groups).toEqual([userBGroup]);
    expect(sessionState.setCloudOffline).not.toHaveBeenCalled();
    expect(sessionState.setCloudError).not.toHaveBeenCalled();
  });

  test('stops a delayed delete without clearing the new user cache or reporting offline', async () => {
    const sharedDelete = deferred<{ error: null }>();
    const secondEq = jest.fn(() => sharedDelete.promise);
    const firstEq = jest.fn(() => ({ eq: secondEq }));
    const client = {
      from: jest.fn((table: string) => {
        if (table !== 'shared_entries') throw new Error(`unexpected table: ${table}`);
        return { delete: jest.fn(() => ({ eq: firstEq })) };
      }),
    };
    const sessionState = mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');
    useGroupStore.setState({ groups: [oldGroup], cachedUserId: 'user-a' });

    const request = useGroupStore.getState().deleteGroup('old-group');
    await flushPromises();
    useGroupStore.getState().setAuthUserId('user-b');
    useGroupStore.setState({ groups: [userBGroup], cachedUserId: 'user-b' });
    sharedDelete.resolve({ error: null });

    await expect(request).rejects.toThrow(/認証状態が変更/);
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(useGroupStore.getState().groups).toEqual([userBGroup]);
    expect(sessionState.setCloudOffline).not.toHaveBeenCalled();
    expect(sessionState.setCloudError).not.toHaveBeenCalled();
  });

  test('does not put schedule rows from the previous user into the new cache', async () => {
    const schedules = deferred<{ data: object[]; error: null }>();
    const order = jest.fn(() => schedules.promise);
    const client = {
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            gte: jest.fn(() => ({
              lte: jest.fn(() => ({ order })),
            })),
          })),
        })),
      })),
    };
    mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');

    const request = useGroupStore.getState().fetchGroupSchedules('shared-group');
    await flushPromises();
    useGroupStore.getState().setAuthUserId('user-b');
    const userBEntries = [
      { userId: 'user-b', userName: 'B', userColor: '#222222', date: '2026-09-06' },
    ];
    useGroupStore.setState({ sharedEntries: { 'shared-group': userBEntries } });
    schedules.resolve({
      data: [
        {
          user_id: 'user-a',
          user_name: 'A',
          user_color: '#111111',
          date: '2026-09-05',
        },
      ],
      error: null,
    });
    await request.catch(() => undefined);

    expect(useGroupStore.getState().sharedEntries['shared-group']).toEqual(userBEntries);
  });

  test('discards a schedule fetch when a group mutation starts afterward', async () => {
    const schedules = deferred<{ data: object[]; error: null }>();
    const createdRow = {
      id: 'new-group',
      name: 'New group',
      color: '#abcdef',
      emoji: '✨',
      invite_code: 'NEWNEW',
      shared_memo: null,
      created_at: '2026-09-05T05:00:00.000Z',
    };
    const created = deferred<{ data: typeof createdRow; error: null }>();
    const client = {
      rpc: jest.fn(() => ({ single: jest.fn(() => created.promise) })),
      from: jest.fn((table: string) => {
        if (table !== 'shared_entries') throw new Error(`unexpected table: ${table}`);
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              gte: jest.fn(() => ({
                lte: jest.fn(() => ({ order: jest.fn(() => schedules.promise) })),
              })),
            })),
          })),
        };
      }),
    };
    mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');
    const currentEntries = [
      { userId: 'user-a', userName: 'A', userColor: '#111111', date: '2026-09-06' },
    ];
    useGroupStore.setState({ sharedEntries: { 'shared-group': currentEntries } });

    const scheduleRequest = useGroupStore.getState().fetchGroupSchedules('shared-group');
    await flushPromises();
    const createRequest = useGroupStore.getState().createGroup('New group', '#abcdef', '✨');
    schedules.resolve({
      data: [
        {
          user_id: 'user-a',
          user_name: 'A',
          user_color: '#111111',
          date: '2026-09-05',
        },
      ],
      error: null,
    });
    await scheduleRequest;
    expect(useGroupStore.getState().sharedEntries['shared-group']).toEqual(currentEntries);

    created.resolve({ data: createdRow, error: null });
    await createRequest;
  });
});

describe('server-confirmed group edits', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('../lib/supabase');
    jest.dontMock('../store/appSessionStore');
    jest.resetModules();
  });

  test('keeps the persisted memo and name when the server rejects edits', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = {
      from: jest.fn(() => ({
        update: jest.fn(() => ({
          eq: jest.fn(() => ({
            select: jest.fn(() => ({
              maybeSingle: jest.fn(async () => ({
                data: null,
                error: { message: 'permission denied' },
              })),
            })),
          })),
        })),
      })),
    };
    mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');
    useGroupStore.setState({ groups: [oldGroup], cachedUserId: 'user-a' });

    await expect(
      useGroupStore.getState().updateSharedMemo('old-group', 'rejected memo')
    ).rejects.toThrow();
    await expect(
      useGroupStore.getState().updateGroupName('old-group', 'Rejected name')
    ).rejects.toThrow();

    expect(useGroupStore.getState().groups[0]).toMatchObject({
      name: 'Old name',
      sharedMemo: 'old memo',
    });
  });

  test('does not expose a memo locally until the server accepts it', async () => {
    const serverWrite = deferred<{
      data: { id: string; shared_memo: string };
      error: null;
    }>();
    const client = {
      from: jest.fn(() => ({
        update: jest.fn(() => ({
          eq: jest.fn(() => ({
            select: jest.fn(() => ({ maybeSingle: jest.fn(() => serverWrite.promise) })),
          })),
        })),
      })),
    };
    mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');
    useGroupStore.setState({ groups: [oldGroup], cachedUserId: 'user-a' });

    const request = useGroupStore.getState().updateSharedMemo('old-group', 'accepted memo');
    await flushPromises();
    expect(useGroupStore.getState().groups[0].sharedMemo).toBe('old memo');

    serverWrite.resolve({
      data: { id: 'old-group', shared_memo: 'accepted memo' },
      error: null,
    });
    await request;
    expect(useGroupStore.getState().groups[0].sharedMemo).toBe('accepted memo');
  });

  test('does not commit memo or name when the update matched no server row', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = {
      from: jest.fn(() => ({
        update: jest.fn(() => ({
          eq: jest.fn(() => ({
            select: jest.fn(() => ({
              maybeSingle: jest.fn(async () => ({ data: null, error: null })),
            })),
          })),
        })),
      })),
    };
    mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');
    useGroupStore.setState({ groups: [oldGroup], cachedUserId: 'user-a' });

    await expect(
      useGroupStore.getState().updateSharedMemo('old-group', 'missing memo')
    ).rejects.toThrow();
    await expect(
      useGroupStore.getState().updateGroupName('old-group', 'Missing name')
    ).rejects.toThrow();
    expect(useGroupStore.getState().groups[0]).toMatchObject({
      name: 'Old name',
      sharedMemo: 'old memo',
    });
  });

  test('serializes memo writes across callers and continues after a failed write', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const firstWrite = deferred<{
      data: null;
      error: { message: string };
    }>();
    const updates: string[] = [];
    const update = jest.fn((patch: { shared_memo: string }) => {
      updates.push(patch.shared_memo);
      return {
        eq: jest.fn(() => ({
          select: jest.fn(() => ({
            maybeSingle: jest.fn(() =>
              patch.shared_memo === 'memo A'
                ? firstWrite.promise
                : Promise.resolve({
                    data: { id: 'old-group', shared_memo: patch.shared_memo },
                    error: null,
                  })
            ),
          })),
        })),
      };
    });
    const client = { from: jest.fn(() => ({ update })) };
    mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');
    useGroupStore.setState({ groups: [oldGroup], cachedUserId: 'user-a' });

    const saveA = useGroupStore.getState().updateSharedMemo('old-group', 'memo A');
    const saveB = useGroupStore.getState().updateSharedMemo('old-group', 'memo B');
    const observedA = expect(saveA).rejects.toThrow();
    await flushPromises();
    expect(updates).toEqual(['memo A']);

    firstWrite.resolve({ data: null, error: { message: 'offline' } });
    await observedA;
    await saveB;
    expect(updates).toEqual(['memo A', 'memo B']);
    expect(useGroupStore.getState().groups[0].sharedMemo).toBe('memo B');
  });

  test('serializes names across sheet instances so the later draft wins', async () => {
    const firstWrite = deferred<{
      data: { id: string; name: string };
      error: null;
    }>();
    const updates: string[] = [];
    const update = jest.fn((patch: { name: string }) => {
      updates.push(patch.name);
      return {
        eq: jest.fn(() => ({
          select: jest.fn(() => ({
            maybeSingle: jest.fn(() =>
              patch.name === 'Name A'
                ? firstWrite.promise
                : Promise.resolve({
                    data: { id: 'old-group', name: patch.name },
                    error: null,
                  })
            ),
          })),
        })),
      };
    });
    const client = { from: jest.fn(() => ({ update })) };
    mockGroupStoreDependencies(client);
    const { useGroupStore } =
      require('../store/groupStore') as typeof import('../store/groupStore');
    useGroupStore.getState().setAuthUserId('user-a');
    useGroupStore.setState({ groups: [oldGroup], cachedUserId: 'user-a' });

    const saveA = useGroupStore.getState().updateGroupName('old-group', 'Name A');
    const saveB = useGroupStore.getState().updateGroupName('old-group', 'Name B');
    await flushPromises();
    expect(updates).toEqual(['Name A']);

    firstWrite.resolve({ data: { id: 'old-group', name: 'Name A' }, error: null });
    await saveA;
    await saveB;
    expect(updates).toEqual(['Name A', 'Name B']);
    expect(useGroupStore.getState().groups[0].name).toBe('Name B');
  });
});

describe('group detail lifecycle safety', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('../store/groupStore');
    jest.dontMock('../store/calendarStore');
    jest.dontMock('../store/stampStore');
    jest.dontMock('../constants/i18n');
    jest.dontMock('@expo/vector-icons');
    jest.dontMock('../utils/haptics');
    jest.resetModules();
  });

  test.each(['unmount', 'hide'] as const)(
    'does not prompt from a failed memo save after %s',
    async (lifecycle) => {
    const save = deferred<void>();
    const updateSharedMemo = jest.fn(() => save.promise);
    const groupState = {
      updateSharedMemo,
      updateGroupName: jest.fn(async () => undefined),
      setGroupIconUri: jest.fn(),
      sharingSettings: {},
      setSharingSettings: jest.fn(),
      syncMySchedule: jest.fn(async () => undefined),
      fetchGroupSchedules: jest.fn(async () => undefined),
      sharedEntries: {},
      myUserId: 'user-a',
      myName: 'A',
    };

    jest.resetModules();
    jest.doMock('../store/groupStore', () => ({
      useGroupStore: (selector: (state: typeof groupState) => unknown) => selector(groupState),
    }));
    jest.doMock('../store/calendarStore', () => ({
      useCalendarStore: (selector: (state: { entries: object }) => unknown) =>
        selector({ entries: {} }),
    }));
    jest.doMock('../store/stampStore', () => ({
      useStampStore: (selector: (state: { getStamp: jest.Mock }) => unknown) =>
        selector({ getStamp: jest.fn() }),
    }));
    jest.doMock('../constants/i18n', () => ({
      useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
    }));
    jest.doMock('@expo/vector-icons', () => ({ Ionicons: () => null }));
    jest.doMock('../utils/haptics', () => ({
      Haptics: {
        selectionAsync: jest.fn(),
        notificationAsync: jest.fn(),
        NotificationFeedbackType: { Success: 'success' },
      },
    }));

    const React = require('react') as typeof import('react');
    const reactNative = require('react-native') as typeof import('react-native');
    Object.defineProperty(reactNative.Platform, 'OS', {
      configurable: true,
      value: 'web',
    });
    const testing =
      require('@testing-library/react-native/pure') as typeof import('@testing-library/react-native/pure');
    const { GroupDetailSheet } =
      require('../components/groups/GroupDetailSheet') as typeof import('../components/groups/GroupDetailSheet');
    const confirm = jest.fn(() => false);
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const props = {
      group: oldGroup,
      visible: true,
      onClose: jest.fn(),
      onDelete: jest.fn(),
      onShare: jest.fn(),
    };
    const rendered = testing.render(React.createElement(GroupDetailSheet, props));
    const memoInput = rendered.getByPlaceholderText('groupDetail.memoPh');
    testing.fireEvent(memoInput, 'blur');
    if (lifecycle === 'unmount') {
      rendered.unmount();
    } else {
      rendered.rerender(
        React.createElement(GroupDetailSheet, { ...props, visible: false })
      );
    }

    await testing.act(async () => {
      save.reject(new Error('offline'));
      await flushPromises();
    });
    expect(confirm).not.toHaveBeenCalled();
    if (lifecycle === 'hide') rendered.unmount();
    }
  );
});
