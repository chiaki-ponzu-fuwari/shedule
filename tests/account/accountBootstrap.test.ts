import type { CloudRepository, CloudRow, CloudRowSeed } from '../../lib/account/cloudRepository';
import { CloudRepositoryError, createMemoryCloudRepository } from '../../lib/account/cloudRepository';
import {
  createAccountBootstrapCoordinator,
  type AccountBootstrapAccountPort,
  type AccountBootstrapGate,
  type AccountBootstrapIdentity,
  type AccountBootstrapOutbox,
  type AccountBootstrapPersistence,
  type AccountOwnerPort,
} from '../../lib/account/accountBootstrap';
import type { DataOwner } from '../../lib/account/namespacedStorage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function row(id: string, note: string, ownerId?: string): CloudRowSeed {
  return {
    ...(ownerId ? { ownerId } : {}),
    entity: 'calendar-entry',
    id,
    revision: 1,
    payload: { date: id, miniStamps: {}, privacyLevel: 2, notes: note },
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
}

function accountIdentity(userId: string): AccountBootstrapIdentity {
  return {
    kind: 'account',
    userId,
    provider: 'google',
    email: `${userId}@example.com`,
  };
}

function createHarness(input: {
  currentOwner?: DataOwner;
  activeAccountId?: string | null;
  rowsByOwner?: Record<string, CloudRowSeed[]>;
  repository?: CloudRepository | null;
  switchOwner?: (owner: DataOwner) => Promise<void>;
  outboxResult?: 'synced' | 'pending' | 'reauth-required' | 'error';
} = {}) {
  let currentOwner: DataOwner = input.currentOwner ?? { kind: 'guest', id: 'install-1' };
  let activeAccountId = input.activeAccountId ?? null;
  let pending: { targetUserId: string; sourceRows: CloudRowSeed[] | null } | null = null;
  const rowsByOwner = input.rowsByOwner ?? {};
  const calls: string[] = [];
  const gates: AccountBootstrapGate[] = [];
  const accountState: Record<string, unknown> = {};
  const backups: CloudRow[][] = [];
  const completions: Array<{ ownerId: string; rows: CloudRow[]; cursor: string }> = [];

  const owners: AccountOwnerPort = {
    getCurrentOwner: async () => currentOwner,
    getInstallationGuestOwner: async () => ({ kind: 'guest', id: 'install-1' }),
    switchOwnerAndRehydrate: async (owner) => {
      calls.push(`switch:${owner.kind}:${owner.id}`);
      if (input.switchOwner) await input.switchOwner(owner);
      currentOwner = owner.kind === 'guest' ? { kind: 'guest', id: 'install-1' } : owner;
    },
  };

  const persistence: AccountBootstrapPersistence = {
    readBinding: async () => ({
      activeAccountId,
      pendingTransition: pending
        ? { ...pending, sourceRows: pending.sourceRows?.map((item) => ({ ...item })) ?? null }
        : null,
    }),
    beginTransition: async (transition) => {
      calls.push(`begin:${transition.targetUserId}`);
      pending = {
        targetUserId: transition.targetUserId,
        sourceRows: transition.sourceRows?.map((item) => ({ ...item })) ?? null,
      };
    },
    completeTransition: async (userId) => {
      calls.push(`complete:${userId}`);
      activeAccountId = userId;
      pending = null;
    },
    clearAccountBinding: async () => {
      calls.push('clear-binding');
      activeAccountId = null;
      pending = null;
    },
    recoverOwner: async (ownerId) => {
      calls.push(`recover:${ownerId}`);
    },
    readLocalRows: async (owner) => {
      calls.push(`read:${owner.kind}:${owner.id}`);
      return (rowsByOwner[`${owner.kind}:${owner.id}`] ?? []).map((item) => ({ ...item }));
    },
    stageSourceRows: async (ownerId, rows) => {
      calls.push(`stage:${ownerId}`);
      rowsByOwner[`user:${ownerId}`] = rows.map((item) => ({ ...item, ownerId }));
    },
    persistLocalBackup: async (_ownerId, rows) => {
      calls.push('backup');
      backups.push(rows.map((item) => ({ ...item })));
    },
    commitMigration: async (ownerId, completion) => {
      calls.push(`commit:${ownerId}`);
      completions.push({
        ownerId,
        rows: completion.rows.map((item) => ({ ...item })),
        cursor: completion.cursor,
      });
    },
  };

  const account: AccountBootstrapAccountPort = {
    resetToGuest: () => {
      calls.push('account:guest-local');
      Object.assign(accountState, { mode: 'guest-local', syncPhase: 'local-only', userId: null });
    },
    setGuestConnected: (userId) => {
      calls.push(`account:guest-connected:${userId}`);
      Object.assign(accountState, { mode: 'guest-connected', syncPhase: 'local-only', userId });
    },
    markConnected: (details) => {
      calls.push(`account:connected:${details.userId}`);
      Object.assign(accountState, { mode: 'account-connected', syncPhase: 'pending', ...details });
    },
    markSyncing: () => {
      calls.push('account:syncing');
      accountState.syncPhase = 'syncing';
    },
    markSynced: (at) => {
      calls.push('account:synced');
      Object.assign(accountState, { syncPhase: 'synced', lastSyncedAt: at });
    },
    markConflictBackedUp: (at) => {
      calls.push('account:conflict-backed-up');
      Object.assign(accountState, { syncPhase: 'conflict-backed-up', lastSyncedAt: at });
    },
    markOffline: (message) => {
      calls.push('account:offline');
      Object.assign(accountState, { connectivity: 'offline', error: message });
    },
    markReauthRequired: (message) => {
      calls.push('account:reauth');
      Object.assign(accountState, { syncPhase: 'reauth-required', error: message });
    },
    markError: (message) => {
      calls.push('account:error');
      Object.assign(accountState, { syncPhase: 'error', error: message });
    },
  };

  const outbox: AccountBootstrapOutbox = {
    flush: async (ownerId) => {
      calls.push(`outbox:${ownerId}`);
      return { syncPhase: input.outboxResult ?? 'synced' };
    },
  };

  const repository = input.repository === undefined
    ? createMemoryCloudRepository([], { defaultOwnerId: 'user-a' })
    : input.repository;
  const coordinator = createAccountBootstrapCoordinator({
    owners,
    persistence,
    outbox,
    repository,
    account,
    now: () => new Date('2026-09-05T12:00:00.000Z'),
    onGateChange: (gate) => gates.push(gate),
  });

  return {
    coordinator,
    calls,
    gates,
    accountState,
    backups,
    completions,
    get currentOwner() { return currentOwner; },
    get activeAccountId() { return activeAccountId; },
    get pending() { return pending; },
  };
}

describe('account bootstrap coordinator', () => {
  test('guest → A captures guest rows, hides the UI, switches cache, then completes verified sync', async () => {
    const repository = createMemoryCloudRepository([], { defaultOwnerId: 'user-a' });
    const harness = createHarness({
      rowsByOwner: { 'guest:install-1': [row('2026-09-05', 'guest note')] },
      repository,
    });

    const promise = harness.coordinator.observe(accountIdentity('user-a'));
    expect(harness.coordinator.getGate().status).toBe('bootstrapping');
    await expect(promise).resolves.toMatchObject({ status: 'ready', ownerId: 'user-a' });

    expect(harness.calls).toEqual([
      'read:guest:install-1',
      'begin:user-a',
      'switch:user:user-a',
      'recover:user-a',
      'stage:user-a',
      'account:connected:user-a',
      'account:syncing',
      'backup',
      'commit:user-a',
      'outbox:user-a',
      'complete:user-a',
      'account:synced',
    ]);
    expect(repository.calls.map((call) => call.method)).toEqual([
      'pull', 'applyMutation', 'pull', 'verify',
    ]);
    expect(harness.currentOwner).toEqual({ kind: 'user', id: 'user-a' });
    expect(harness.activeAccountId).toBe('user-a');
    expect(harness.accountState).toMatchObject({
      mode: 'account-connected',
      syncPhase: 'synced',
      userId: 'user-a',
    });
  });

  test('cold restart A trusts the durable owner hint only after A is verified and never reads guest rows', async () => {
    const repository = createMemoryCloudRepository([], { defaultOwnerId: 'user-a' });
    const harness = createHarness({
      activeAccountId: 'user-a',
      rowsByOwner: {
        'guest:install-1': [row('guest-secret', 'must not cross')],
        'user:user-a': [row('a-only', 'A cache', 'user-a')],
      },
      repository,
    });

    await harness.coordinator.observe(accountIdentity('user-a'));

    expect(harness.calls).not.toContain('read:guest:install-1');
    expect(harness.calls).toContain('read:user:user-a');
    expect([...repository.rowsFor('user-a').keys()]).toEqual(['a-only']);
  });

  test('A → B gates immediately and does not read or migrate A rows into B', async () => {
    const repository = createMemoryCloudRepository([], { defaultOwnerId: 'user-b' });
    const harness = createHarness({
      currentOwner: { kind: 'user', id: 'user-a' },
      activeAccountId: 'user-a',
      rowsByOwner: {
        'user:user-a': [row('a-secret', 'A only', 'user-a')],
        'user:user-b': [row('b-only', 'B only', 'user-b')],
      },
      repository,
    });

    const switching = harness.coordinator.observe(accountIdentity('user-b'));
    expect(harness.coordinator.getGate().status).toBe('bootstrapping');
    await switching;

    expect(harness.calls).not.toContain('read:user:user-a');
    expect(harness.calls).toContain('read:user:user-b');
    expect([...repository.rowsFor('user-b').keys()]).toEqual(['b-only']);
    expect([...repository.rowsFor('user-a').keys()]).toEqual([]);
    expect(harness.currentOwner).toEqual({ kind: 'user', id: 'user-b' });
  });

  test.each([
    [{ kind: 'guest-local' } as const, 'account:guest-local'],
    [{ kind: 'anonymous', userId: 'anonymous-auth-id' } as const, 'account:guest-connected:anonymous-auth-id'],
  ])('signout/delete or anonymous auth returns to the installation guest namespace', async (identity, accountCall) => {
    const harness = createHarness({
      currentOwner: { kind: 'user', id: 'user-a' },
      activeAccountId: 'user-a',
    });

    await harness.coordinator.observe(identity);

    expect(harness.currentOwner).toEqual({ kind: 'guest', id: 'install-1' });
    expect(harness.activeAccountId).toBeNull();
    expect(harness.calls).toContain('clear-binding');
    expect(harness.calls).toContain(accountCall);
    expect(harness.coordinator.getGate()).toMatchObject({ status: 'ready', ownerId: 'install-1' });
  });

  test('owner-switch failure rolls back underneath a blocked gate and never reports synced', async () => {
    const harness = createHarness({
      currentOwner: { kind: 'user', id: 'user-a' },
      activeAccountId: 'user-a',
      switchOwner: async () => { throw new Error('rehydration failed'); },
    });

    await expect(harness.coordinator.observe(accountIdentity('user-b'))).resolves.toMatchObject({
      status: 'blocked',
    });

    expect(harness.currentOwner).toEqual({ kind: 'user', id: 'user-a' });
    expect(harness.calls).not.toContain('account:synced');
    expect(harness.coordinator.getGate().status).toBe('blocked');
  });

  test('a newer identity supersedes an older asynchronous switch and only the latest result can publish', async () => {
    const firstSwitch = deferred<void>();
    let switchCount = 0;
    const repository = createMemoryCloudRepository([], { defaultOwnerId: 'user-b' });
    const harness = createHarness({
      repository,
      switchOwner: async () => {
        switchCount += 1;
        if (switchCount === 1) await firstSwitch.promise;
      },
      rowsByOwner: { 'user:user-b': [row('b-only', 'B', 'user-b')] },
    });

    const first = harness.coordinator.observe(accountIdentity('user-a'));
    await Promise.resolve();
    const second = harness.coordinator.observe(accountIdentity('user-b'));
    expect(harness.coordinator.getGate().status).toBe('bootstrapping');

    firstSwitch.resolve();
    await expect(first).resolves.toMatchObject({ status: 'superseded' });
    await expect(second).resolves.toMatchObject({ status: 'ready', ownerId: 'user-b' });

    expect(harness.calls).not.toContain('account:connected:user-a');
    expect(harness.calls).not.toContain('outbox:user-a');
    expect(harness.accountState).toMatchObject({ userId: 'user-b', syncPhase: 'synced' });
    expect(harness.currentOwner).toEqual({ kind: 'user', id: 'user-b' });
  });

  test('an unverified auth event invalidates in-flight work before its result can reopen the UI', async () => {
    const firstSwitch = deferred<void>();
    const harness = createHarness({
      switchOwner: async () => { await firstSwitch.promise; },
    });
    const first = harness.coordinator.observe(accountIdentity('user-a'));
    await Promise.resolve();

    harness.coordinator.invalidate();
    expect(harness.coordinator.getGate().status).toBe('bootstrapping');
    firstSwitch.resolve();

    await expect(first).resolves.toEqual({ status: 'superseded' });
    expect(harness.coordinator.getGate().status).toBe('bootstrapping');
    expect(harness.calls).not.toContain('account:synced');
  });

  test('offline initial sync exposes only the verified owner cache as a safe failure, never synced', async () => {
    const repository = createMemoryCloudRepository([], {
      defaultOwnerId: 'user-a',
      offline: true,
    });
    const harness = createHarness({
      activeAccountId: 'user-a',
      rowsByOwner: { 'user:user-a': [row('a-only', 'offline A', 'user-a')] },
      repository,
    });

    await expect(harness.coordinator.observe(accountIdentity('user-a'))).resolves.toMatchObject({
      status: 'safe-failure',
      ownerId: 'user-a',
    });
    expect(harness.currentOwner).toEqual({ kind: 'user', id: 'user-a' });
    expect(harness.calls).toContain('account:offline');
    expect(harness.calls).not.toContain('account:synced');
  });

  test('missing cloud or outbox implementation cannot be reported as a successful backup', async () => {
    const harness = createHarness({ repository: null });

    await harness.coordinator.observe(accountIdentity('user-a'));

    expect(harness.coordinator.getGate().status).toBe('safe-failure');
    expect(harness.accountState.syncPhase).not.toBe('synced');
  });

  test('verification failure blocks before selecting any private namespace', async () => {
    const harness = createHarness({ activeAccountId: 'user-a' });
    await harness.coordinator.observe({
      kind: 'verification-failed',
      error: new CloudRepositoryError('auth', 'invalid session', false),
    });

    expect(harness.calls.some((call) => call.startsWith('switch:user:'))).toBe(false);
    expect(harness.coordinator.getGate().status).toBe('blocked');
    expect(harness.calls).toContain('account:reauth');
  });

  test('Apple revocation opens only the already-bound owner cache and performs no cloud access', async () => {
    const repository = createMemoryCloudRepository([], { defaultOwnerId: 'user-apple' });
    const harness = createHarness({
      currentOwner: { kind: 'user', id: 'user-apple' },
      activeAccountId: 'user-apple',
      repository,
      rowsByOwner: {
        'user:user-apple': [row('apple-local', 'kept local', 'user-apple')],
      },
    });

    await expect(harness.coordinator.observe({
      kind: 'reauth-required-account',
      userId: 'user-apple',
      provider: 'apple',
      email: 'relay@privaterelay.appleid.com',
    })).resolves.toMatchObject({ status: 'safe-failure', ownerId: 'user-apple' });

    expect(harness.calls).toEqual([
      'switch:user:user-apple',
      'recover:user-apple',
      'account:connected:user-apple',
      'account:reauth',
    ]);
    expect(repository.calls).toHaveLength(0);
    expect(harness.accountState).toMatchObject({
      mode: 'account-connected',
      syncPhase: 'reauth-required',
      userId: 'user-apple',
    });
  });

  test('Apple revocation never opens another account cache when the UID is not durably bound', async () => {
    const repository = createMemoryCloudRepository([], { defaultOwnerId: 'user-apple' });
    const harness = createHarness({
      currentOwner: { kind: 'user', id: 'other-user' },
      activeAccountId: 'other-user',
      repository,
    });

    await harness.coordinator.observe({
      kind: 'reauth-required-account',
      userId: 'user-apple',
      provider: 'apple',
      email: null,
    });

    expect(harness.currentOwner).toEqual({ kind: 'guest', id: 'install-1' });
    expect(harness.calls).not.toContain('switch:user:user-apple');
    expect(repository.calls).toHaveLength(0);
  });

  test('never exposes repository or storage error details in user-visible state', async () => {
    const base = createMemoryCloudRepository([], { defaultOwnerId: 'user-a' });
    const repository: CloudRepository = {
      pull: async () => {
        throw new Error('postgres secret: relation private.apple_credentials');
      },
      getMutationReceipts: base.getMutationReceipts.bind(base),
      applyMutation: base.applyMutation.bind(base),
      verify: base.verify.bind(base),
    };
    const harness = createHarness({ repository });

    await harness.coordinator.observe(accountIdentity('user-a'));

    expect(JSON.stringify(harness.coordinator.getGate())).not.toContain('apple_credentials');
    expect(JSON.stringify(harness.accountState)).not.toContain('apple_credentials');
  });
});
