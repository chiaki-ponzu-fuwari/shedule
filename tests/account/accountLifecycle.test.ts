import {
  createAccountLifecycleCoordinator,
  type AccountLifecycleDependencies,
} from '../../lib/account/accountLifecycle';
import type { PersonalSnapshot } from '../../types/account';

const emptySnapshot = (): PersonalSnapshot => ({
  entries: {},
  specialDates: [],
  preferences: {},
  stamps: [],
  trips: [],
  tripItems: [],
});

const fullSnapshot = (): PersonalSnapshot => ({
  ...emptySnapshot(),
  entries: {
    '2026-09-05': {
      date: '2026-09-05',
      miniStamps: {},
      privacyLevel: 0,
      notes: '持ち物を確認',
    },
  },
  trips: [{
    id: 'trip-1',
    title: '札幌',
    startDate: '2026-10-01',
    endDate: '2026-10-03',
    color: '#2878F0',
    startIcon: 'airplane',
    endIcon: 'airplane',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    revision: 1,
  }],
});

function clone(snapshot: PersonalSnapshot): PersonalSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as PersonalSnapshot;
}

function fixture(options: {
  local?: PersonalSnapshot;
  remote?: PersonalSnapshot;
  deleteResult?: { ok: boolean; retryable?: boolean; requestId?: string; error?: string };
  cleanupFailure?: 'local' | 'outbox' | 'notifications' | 'credentials' | 'session';
} = {}) {
  let local = clone(options.local ?? fullSnapshot());
  const remote = clone(options.remote ?? fullSnapshot());
  const calls: string[] = [];
  const states: string[] = [];
  const fail = async (name: NonNullable<typeof options.cleanupFailure>) => {
    calls.push(name);
    if (options.cleanupFailure === name) throw new Error(`${name} failed`);
  };

  const dependencies: AccountLifecycleDependencies = {
    remote: {
      async readSnapshot(ownerId) {
        calls.push(`remote:read:${ownerId}`);
        return clone(remote);
      },
      async deleteAccount(proof) {
        calls.push(`remote:delete:${proof}`);
        return options.deleteResult ?? { ok: true, requestId: 'delete-1' };
      },
    },
    local: {
      async replaceAtomically(ownerId, snapshot) {
        calls.push(`local:replace:${ownerId}`);
        local = clone(snapshot);
      },
      async clear(ownerId) {
        await fail('local');
        calls.push(`local:clear:${ownerId}`);
        local = emptySnapshot();
      },
    },
    outbox: {
      async clear(ownerId) {
        await fail('outbox');
        calls.push(`outbox:clear:${ownerId}`);
      },
    },
    notifications: {
      async cancelAll(ownerId) {
        await fail('notifications');
        calls.push(`notifications:clear:${ownerId}`);
      },
    },
    credentials: {
      async clear(ownerId) {
        await fail('credentials');
        calls.push(`credentials:clear:${ownerId}`);
      },
    },
    session: {
      async clear() {
        await fail('session');
        calls.push('session:clear');
      },
      async createAnonymous() {
        calls.push('session:create-anonymous');
      },
    },
    setLifecycleState(state) {
      states.push(state);
    },
  };

  return {
    dependencies,
    calls,
    states,
    get local() { return clone(local); },
    remote,
  };
}

describe('account restore, logout, and deletion lifecycle', () => {
  test('restores the complete remote snapshot into an empty account cache', async () => {
    const f = fixture({ local: emptySnapshot(), remote: fullSnapshot() });

    await createAccountLifecycleCoordinator(f.dependencies).restore('user-1');

    expect(f.local).toEqual(fullSnapshot());
    expect(f.calls).toEqual(['remote:read:user-1', 'local:replace:user-1']);
    expect(f.states).toEqual(['restoring', 'ready']);
  });

  test('logging out clears only local user state and never deletes cloud rows', async () => {
    const f = fixture();

    await createAccountLifecycleCoordinator(f.dependencies).logout('user-1');

    expect(f.local).toEqual(emptySnapshot());
    expect(f.remote).toEqual(fullSnapshot());
    expect(f.calls).toEqual(expect.arrayContaining([
      'local:clear:user-1',
      'outbox:clear:user-1',
      'notifications:clear:user-1',
      'credentials:clear:user-1',
      'session:clear',
    ]));
    expect(f.calls.some((call) => call.startsWith('remote:delete'))).toBe(false);
    expect(f.calls).not.toContain('session:create-anonymous');
  });

  test('a retryable server deletion failure keeps local data and enters pending state', async () => {
    const f = fixture({
      deleteResult: { ok: false, retryable: true, requestId: 'delete-1', error: 'offline' },
    });

    await expect(createAccountLifecycleCoordinator(f.dependencies).deleteAccount({
      ownerId: 'user-1',
      reauthenticationProof: 'fresh-proof',
    })).resolves.toEqual({
      status: 'deletion-pending',
      requestId: 'delete-1',
      error: 'offline',
    });
    expect(f.local).toEqual(fullSnapshot());
    expect(f.calls).toEqual(['remote:delete:fresh-proof']);
    expect(f.states).toEqual(['deleting', 'deletion-pending']);
  });

  test('successful deletion clears every local surface without auto-creating a guest', async () => {
    const f = fixture();

    await expect(createAccountLifecycleCoordinator(f.dependencies).deleteAccount({
      ownerId: 'user-1',
      reauthenticationProof: 'fresh-proof',
    })).resolves.toEqual({ status: 'deleted', requestId: 'delete-1' });

    expect(f.local).toEqual(emptySnapshot());
    expect(f.calls).toEqual(expect.arrayContaining([
      'remote:delete:fresh-proof',
      'local:clear:user-1',
      'outbox:clear:user-1',
      'notifications:clear:user-1',
      'credentials:clear:user-1',
      'session:clear',
    ]));
    expect(f.calls).not.toContain('session:create-anonymous');
    expect(f.states).toEqual(['deleting', 'deleted']);
  });

  test('post-deletion cleanup attempts every surface and remains pending if one fails', async () => {
    const f = fixture({ cleanupFailure: 'outbox' });

    const result = await createAccountLifecycleCoordinator(f.dependencies).deleteAccount({
      ownerId: 'user-1',
      reauthenticationProof: 'fresh-proof',
    });

    expect(result.status).toBe('local-cleanup-pending');
    expect(f.calls).toEqual(expect.arrayContaining([
      'local',
      'outbox',
      'notifications',
      'credentials',
      'session',
    ]));
    expect(f.states).toEqual(['deleting', 'deletion-pending']);
  });

  test('requires a non-empty fresh reauthentication proof before remote deletion', async () => {
    const f = fixture();

    await expect(createAccountLifecycleCoordinator(f.dependencies).deleteAccount({
      ownerId: 'user-1',
      reauthenticationProof: '   ',
    })).rejects.toThrow(/reauthentication/i);
    expect(f.calls).toEqual([]);
  });
});
