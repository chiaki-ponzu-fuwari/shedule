import {
  OAUTH_CALLBACK_CLAIM_LEASE_MS,
  OAUTH_OPERATION_STORAGE_KEY,
  OAUTH_OPERATION_TTL_MS,
  createOAuthGlobalLockForPlatform,
  createOAuthOperationJournal,
  createWebOAuthGlobalLock,
  type OAuthOperationStorage,
} from '../../lib/account/oauthOperationJournal';

function storageFixture(initial: string | null = null) {
  let value = initial;
  let setFailure: Error | null = null;
  let getFailure: Error | null = null;
  const storage: OAuthOperationStorage = {
    getItem: jest.fn(async () => {
      if (getFailure) throw getFailure;
      return value;
    }),
    setItem: jest.fn(async (_key, next) => {
      if (setFailure) throw setFailure;
      value = next;
    }),
    removeItem: jest.fn(async () => {
      value = null;
    }),
  };
  return {
    storage,
    raw: () => value,
    failSet(error: Error | null) {
      setFailure = error;
    },
    failGet(error: Error | null) {
      getFailure = error;
    },
  };
}

describe('OAuth operation journal', () => {
  test('fails closed on web when origin-wide locks are unavailable', async () => {
    const webLock = createOAuthGlobalLockForPlatform('web', () => undefined);
    expect(webLock).toBeDefined();

    await expect(webLock?.('oauth-operation', async () => 'unsafe exchange'))
      .rejects.toThrow('Secure cross-tab OAuth locking is unavailable');
    expect(createOAuthGlobalLockForPlatform('native', () => undefined)).toBeUndefined();
  });

  test('persists a short-lived transient merge with intent and isolated storage identity', async () => {
    let now = 1_000;
    const fixture = storageFixture();
    const journal = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => now,
      randomUUID: () => 'operation-1',
    });

    const operation = await journal.begin({
      kind: 'transient-merge',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
      transientStorageKey: 'recoto-transient-operation-1',
      intent: { intentId: 'intent-1', nonce: 'merge-nonce' },
    });

    expect(operation).toEqual(expect.objectContaining({
      operationId: 'operation-1',
      kind: 'transient-merge',
      provider: 'google',
      stage: 'awaiting-provider',
      expectedUserId: 'guest-1',
      intent: { intentId: 'intent-1', nonce: 'merge-nonce' },
      transientStorageKey: 'recoto-transient-operation-1',
      expiresAt: 1_000 + OAUTH_OPERATION_TTL_MS,
    }));
    await expect(journal.read()).resolves.toEqual(operation);

    now = operation.expiresAt + 1;
    await expect(journal.read()).resolves.toBeNull();
    expect(fixture.storage.removeItem).toHaveBeenCalled();
  });

  test('claims one callback consumer and rejects a second exchange attempt', async () => {
    const fixture = storageFixture();
    const journal = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => 10,
      randomUUID: () => 'operation-1',
      runtimeId: 'runtime-1',
    });
    await journal.begin({
      kind: 'main-link',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
    });
    await journal.markAwaitingCallback('operation-1');

    const [first, second] = await Promise.all([
      journal.claimCallback('operation-1', 'opener'),
      journal.claimCallback('operation-1', 'route'),
    ]);

    expect([first.status, second.status].sort()).toEqual(['already-claimed', 'claimed']);
    await expect(journal.read()).resolves.toEqual(expect.objectContaining({
      stage: 'callback-claimed',
      callbackClaim: expect.objectContaining({
        consumer: expect.any(String),
        runtimeId: 'runtime-1',
      }),
    }));
  });

  test('persists an identity-owned result so an interrupted merge can be resumed', async () => {
    const fixture = storageFixture();
    const journal = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => 10,
      randomUUID: () => 'operation-1',
    });
    await journal.begin({
      kind: 'main-link',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
    });
    await journal.markAwaitingCallback('operation-1');
    await journal.claimCallback('operation-1', 'route');

    await journal.markIdentityOwned('operation-1');

    await expect(journal.read()).resolves.toEqual(expect.objectContaining({
      kind: 'main-link',
      stage: 'identity-owned',
      expectedUserId: 'guest-1',
    }));
  });

  test('lets a new app runtime reclaim a callback left claimed by a terminated runtime', async () => {
    const fixture = storageFixture();
    let now = 10;
    const firstRuntime = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => now,
      randomUUID: () => 'operation-1',
      runtimeId: 'runtime-before-restart',
    });
    await firstRuntime.begin({
      kind: 'reauth',
      provider: 'google',
      expectedUserId: 'account-9',
      redirectUri: 'recoto://auth/callback',
    });
    await firstRuntime.markAwaitingCallback('operation-1');
    await expect(firstRuntime.claimCallback('operation-1', 'opener')).resolves.toMatchObject({
      status: 'claimed',
    });

    const restartedRuntime = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => now,
      randomUUID: () => 'operation-2',
      runtimeId: 'runtime-after-restart',
    });
    await expect(restartedRuntime.claimCallback('operation-1', 'route')).resolves.toMatchObject({
      status: 'already-claimed',
    });

    now += OAUTH_CALLBACK_CLAIM_LEASE_MS + 1;
    await expect(restartedRuntime.claimCallback('operation-1', 'route')).resolves.toMatchObject({
      status: 'claimed',
      operation: {
        callbackClaim: {
          consumer: 'route',
          claimedAt: 10 + OAUTH_CALLBACK_CLAIM_LEASE_MS + 1,
          runtimeId: 'runtime-after-restart',
        },
      },
    });
  });

  test('serializes callback claims across independent browser-tab storage wrappers', async () => {
    const values = new Map<string, string>();
    const storage = (): OAuthOperationStorage => ({
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => { values.set(key, value); },
      removeItem: async (key) => { values.delete(key); },
    });
    let lockTail = Promise.resolve();
    const webLock = createWebOAuthGlobalLock(() => ({
      request: async <T>(
        _name: string,
        _options: { mode: 'exclusive' },
        callback: () => Promise<T>,
      ) => {
        const previous = lockTail;
        let release: () => void = () => {};
        lockTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    }));
    const first = createOAuthOperationJournal({
      storage: storage(),
      now: () => 10,
      randomUUID: () => 'operation-1',
      runtimeId: 'tab-1',
      withGlobalLock: webLock,
    });
    const second = createOAuthOperationJournal({
      storage: storage(),
      now: () => 10,
      randomUUID: () => 'operation-2',
      runtimeId: 'tab-2',
      withGlobalLock: webLock,
    });
    await first.begin({
      kind: 'main-link',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'https://app.example/auth/callback',
    });
    await first.markAwaitingCallback('operation-1');

    const results = await Promise.all([
      first.claimCallback('operation-1', 'opener'),
      second.claimCallback('operation-1', 'route'),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'already-claimed',
      'claimed',
    ]);
  });

  test('durably inboxes a validated callback before claiming it for exchange', async () => {
    const fixture = storageFixture();
    const journal = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => 10,
      randomUUID: () => 'operation-1',
      runtimeId: 'runtime-1',
    });
    await journal.begin({
      kind: 'reauth',
      provider: 'google',
      expectedUserId: 'account-9',
      redirectUri: 'recoto://auth/callback',
    });
    await journal.markAwaitingCallback('operation-1');

    await journal.saveCallback(
      'operation-1',
      'recoto://auth/callback?code=one-time-code',
    );
    await journal.claimCallback('operation-1', 'route');

    await expect(journal.read()).resolves.toEqual(expect.objectContaining({
      stage: 'callback-claimed',
      callback: {
        url: 'recoto://auth/callback?code=one-time-code',
        receivedAt: 10,
      },
    }));
    await expect(
      journal.saveCallback('operation-1', 'recoto://auth/callback?code=different-code'),
    ).rejects.toThrow(/callback/i);
  });

  test.each(['cancel', 'expiry'] as const)(
    'removes isolated Supabase session artifacts on %s',
    async (mode) => {
      const values = new Map<string, string>();
      const storage: OAuthOperationStorage = {
        getItem: jest.fn(async (key) => values.get(key) ?? null),
        setItem: jest.fn(async (key, value) => { values.set(key, value); }),
        removeItem: jest.fn(async (key) => { values.delete(key); }),
      };
      let now = 10;
      const journal = createOAuthOperationJournal({
        storage,
        now: () => now,
        randomUUID: () => 'operation-1',
      });
      const operation = await journal.begin({
        kind: 'reauth',
        provider: 'google',
        expectedUserId: 'account-9',
        redirectUri: 'recoto://auth/callback',
        transientStorageKey: 'transient-operation-1',
      });
      values.set('transient-operation-1', 'refresh-session');
      values.set('transient-operation-1-code-verifier', 'pkce-verifier');

      if (mode === 'cancel') {
        await journal.cancel(operation.operationId);
      } else {
        now = operation.expiresAt + 1;
        await expect(journal.read()).resolves.toBeNull();
      }

      expect(values.has('transient-operation-1')).toBe(false);
      expect(values.has('transient-operation-1-code-verifier')).toBe(false);
      expect(values.has(OAUTH_OPERATION_STORAGE_KEY)).toBe(false);
    },
  );

  test('never expires a verified recovery session before activation completes', async () => {
    const fixture = storageFixture();
    let now = 10;
    const journal = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => now,
      randomUUID: () => 'operation-1',
    });
    const operation = await journal.begin({
      kind: 'reauth',
      provider: 'google',
      expectedUserId: 'account-9',
      redirectUri: 'recoto://auth/callback',
      transientStorageKey: 'transient-operation-1',
    });
    await journal.saveTargetSession(operation.operationId, {
      userId: 'account-9',
      accessToken: 'recovery-access',
      refreshToken: 'recovery-refresh',
    });

    now = operation.expiresAt + 30 * 24 * 60 * 60 * 1_000;
    await expect(journal.read()).resolves.toEqual(expect.objectContaining({
      stage: 'target-authenticated',
      targetSession: expect.objectContaining({ userId: 'account-9' }),
    }));
  });

  test('journals target tokens before merge completion and keeps them until verified activation', async () => {
    const fixture = storageFixture();
    const journal = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => 10,
      randomUUID: () => 'operation-1',
    });
    await journal.begin({
      kind: 'transient-merge',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
      transientStorageKey: 'transient-1',
      intent: { intentId: 'intent-1', nonce: 'nonce-1' },
    });
    await journal.saveTargetSession('operation-1', {
      userId: 'account-9',
      accessToken: 'target-access',
      refreshToken: 'target-refresh',
    });
    await journal.markMergeCompleted('operation-1', 'account-9');

    await expect(journal.read()).resolves.toEqual(expect.objectContaining({
      stage: 'merge-completed',
      targetSession: expect.objectContaining({
        userId: 'account-9',
        accessToken: 'target-access',
        refreshToken: 'target-refresh',
      }),
    }));
    await journal.clearAfterVerifiedSession('operation-1', 'account-9');
    await expect(journal.read()).resolves.toBeNull();
  });

  test('never clears a merge journal for a different activated UID', async () => {
    const fixture = storageFixture();
    const journal = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => 10,
      randomUUID: () => 'operation-1',
    });
    await journal.begin({
      kind: 'reauth',
      provider: 'google',
      expectedUserId: 'account-9',
      redirectUri: 'recoto://auth/callback',
      transientStorageKey: 'transient-1',
    });
    await journal.saveTargetSession('operation-1', {
      userId: 'account-9',
      accessToken: 'access',
      refreshToken: 'refresh',
    });

    await expect(
      journal.clearAfterVerifiedSession('operation-1', 'other-account'),
    ).rejects.toThrow(/UID/i);
    await expect(journal.read()).resolves.not.toBeNull();
  });

  test('persists Apple linked-but-credential-missing repair state without a one-time code', async () => {
    const fixture = storageFixture();
    const journal = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => 10,
      randomUUID: () => 'operation-1',
    });
    await journal.begin({
      kind: 'main-link',
      provider: 'apple',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
    });
    await journal.markAppleCredentialRepair('operation-1', {
      expectedUserId: 'guest-1',
      expectedNonceHash: 'hashed-nonce',
    });

    const operation = await journal.read();
    expect(operation).toEqual(expect.objectContaining({
      kind: 'apple-credential-repair',
      stage: 'credential-repair-required',
      expectedUserId: 'guest-1',
      apple: { expectedNonceHash: 'hashed-nonce' },
    }));
    expect(fixture.raw()).not.toContain('authorizationCode');
    expect(fixture.raw()).not.toContain('one-time-code');
  });

  test('returns a repaired target credential to its original merge without changing the source UID early', async () => {
    const fixture = storageFixture();
    const journal = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => 10,
      randomUUID: () => 'operation-1',
    });
    const operation = await journal.begin({
      kind: 'transient-merge',
      provider: 'apple',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
      intent: { intentId: 'intent-1', nonce: 'merge-nonce' },
    });
    await journal.markAppleCredentialRepair(operation.operationId, {
      expectedUserId: 'account-9',
      expectedNonceHash: 'hash-1',
      targetSession: {
        userId: 'account-9',
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
      },
    });

    await expect(journal.read()).resolves.toEqual(expect.objectContaining({
      kind: 'apple-credential-repair',
      expectedUserId: 'account-9',
      sourceUserId: 'guest-1',
      intent: { intentId: 'intent-1', nonce: 'merge-nonce' },
    }));
    await journal.completeAppleCredentialRepair(operation.operationId, {
      userId: 'account-9',
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
    });
    await expect(journal.read()).resolves.toEqual(expect.objectContaining({
      kind: 'transient-merge',
      stage: 'target-authenticated',
      expectedUserId: 'guest-1',
      targetSession: expect.objectContaining({
        userId: 'account-9',
        accessToken: 'fresh-access',
      }),
    }));
  });

  test('propagates storage failures instead of treating an unverified write as durable', async () => {
    const fixture = storageFixture();
    const journal = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => 10,
      randomUUID: () => 'operation-1',
    });
    fixture.failSet(new Error('localStorage quota exceeded'));

    await expect(journal.begin({
      kind: 'main-link',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'https://app.example/auth/callback',
    })).rejects.toThrow('localStorage quota exceeded');

    fixture.failSet(null);
    fixture.failGet(new Error('localStorage denied'));
    await expect(journal.read()).rejects.toThrow('localStorage denied');
  });

  test('rejects unexpected persisted fields instead of accepting client-stored provider secrets', async () => {
    const fixture = storageFixture(JSON.stringify({
      version: 1,
      operationId: 'operation-1',
      kind: 'main-link',
      provider: 'apple',
      stage: 'awaiting-provider',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
      authorizationCode: 'must-never-be-persisted',
      createdAt: 10,
      expiresAt: 100,
    }));
    const journal = createOAuthOperationJournal({
      storage: fixture.storage,
      now: () => 10,
      randomUUID: () => 'operation-2',
    });

    await expect(journal.read()).rejects.toThrow(/unexpected|verification/i);
  });
});
