import {
  AccountAuthError,
  createSupabaseAuthGateway,
  inboxAccountOAuthCallback,
  parseAccountOAuthCallback,
  type AccountAuthClient,
  type AccountAuthGatewayDependencies,
} from '../../lib/account/supabaseAuthGateway';
import {
  OAUTH_CALLBACK_CLAIM_LEASE_MS,
  createOAuthOperationJournal,
  type OAuthOperationGlobalLock,
  type OAuthOperationStorage,
} from '../../lib/account/oauthOperationJournal';

type ClientFixture = ReturnType<typeof createClientFixture>;

function createClientFixture(options: {
  userId?: string;
  anonymous?: boolean;
  hostedUrl?: string;
    exchangeUserId?: string;
    exchangeErrorCode?: string;
  providerToken?: string;
  idTokenUserId?: string;
  linkErrorCode?: string;
  functionResults?: Record<string, unknown>;
  functionErrorCodes?: Record<string, string>;
  identityProviders?: string[];
} = {}) {
  const calls: unknown[][] = [];
  const userId = options.userId ?? 'guest-1';
  const makeSession = (id: string) => ({
    access_token: `access-${id}`,
    refresh_token: `refresh-${id}`,
    user: {
      id,
      is_anonymous: options.anonymous ?? id.startsWith('guest-'),
      ...(options.identityProviders
        ? { identities: options.identityProviders.map((provider) => ({ provider })) }
        : {}),
    },
    ...(options.providerToken ? { provider_token: options.providerToken } : {}),
  });
  let session = makeSession(userId);

  const auth: AccountAuthClient['auth'] = {
    async getUser() {
      calls.push(['getUser']);
      return { data: { user: session.user }, error: null };
    },
    async getSession() {
      calls.push(['getSession']);
      return { data: { session }, error: null };
    },
    async linkIdentity(credentials) {
      calls.push(['linkIdentity', credentials]);
      if (options.linkErrorCode) {
        if ('token' in credentials) {
          return {
            data: { user: null, session: null },
            error: { code: options.linkErrorCode, message: 'narrow coded error' },
          };
        }
        return {
          data: { provider: credentials.provider, url: null },
          error: { code: options.linkErrorCode, message: 'narrow coded error' },
        };
      }
      if ('token' in credentials) {
        return { data: { user: session.user, session }, error: null };
      }
      return {
        data: {
          provider: credentials.provider,
          url: options.hostedUrl ?? 'https://auth.example/authorize?state=sdk-state',
        },
        error: null,
      };
    },
    async signInWithOAuth(credentials) {
      calls.push(['signInWithOAuth', credentials]);
      return {
        data: {
          provider: credentials.provider,
          url: options.hostedUrl ?? 'https://auth.example/authorize?state=sdk-state',
        },
        error: null,
      };
    },
    async exchangeCodeForSession(code) {
      calls.push(['exchangeCodeForSession', code]);
      if (options.exchangeErrorCode) {
        return {
          data: { user: null, session: null },
          error: { code: options.exchangeErrorCode, message: 'exchange failed' },
        };
      }
      const nextId = options.exchangeUserId ?? userId;
      session = makeSession(nextId);
      return { data: { user: session.user, session }, error: null };
    },
    async signInWithIdToken(credentials) {
      calls.push(['signInWithIdToken', credentials]);
      const nextId = options.idTokenUserId ?? userId;
      session = makeSession(nextId);
      return { data: { user: session.user, session }, error: null };
    },
    async setSession(tokens) {
      calls.push(['setSession', tokens]);
      const id = tokens.access_token.replace('access-', '');
      session = makeSession(id);
      return { data: { user: session.user, session }, error: null };
    },
  };

  const client: AccountAuthClient = {
    auth,
    functions: {
      async invoke(name, request) {
        calls.push(['invoke', name, request?.body]);
        const functionErrorCode = options.functionErrorCodes?.[name];
        if (functionErrorCode) {
          return {
            data: null,
            error: { code: functionErrorCode, message: 'function failed' },
          };
        }
        return {
          data: options.functionResults?.[name] ?? null,
          error: null,
        };
      },
    },
  };

  return { client, calls };
}

function createDependencies({
  main,
  transient,
  platform = 'ios',
  authResult = { type: 'success' as const, url: 'recoto://auth/callback?code=pkce-code' },
  appleCredential,
}: {
  main: ClientFixture;
  transient?: ClientFixture;
  platform?: AccountAuthGatewayDependencies['platform'];
  authResult?: { type: 'success'; url: string } | { type: 'cancel' | 'dismiss' };
  appleCredential?: {
    identityToken: string | null;
    authorizationCode: string | null;
    state: string | null;
  };
}) {
  const calls: unknown[][] = [];
  const journalValues = new Map<string, string>();
  const journalWrites: string[] = [];
  let operationSequence = 0;
  const operationStorage: OAuthOperationStorage = {
      getItem: async (key) => journalValues.get(key) ?? null,
      setItem: async (key, value) => {
        journalWrites.push(value);
        journalValues.set(key, value);
      },
      removeItem: async (key) => {
        journalValues.delete(key);
      },
    };
  const operationJournal = createOAuthOperationJournal({
    storage: operationStorage,
    now: () => 1_000,
    randomUUID: () => `operation-${++operationSequence}`,
  });
  const transientFixture = transient ?? createClientFixture({ userId: 'account-9', anonymous: false });
  const dependencies: AccountAuthGatewayDependencies = {
    mainClient: main.client,
    createTransientClient: (storageKey) => {
      calls.push(['createTransientClient', storageKey]);
      return transientFixture.client;
    },
    clearTransientStorage: async (storageKey) => {
      calls.push(['clearTransientStorage', storageKey]);
    },
    operationJournal,
    platform,
    redirectUri: 'recoto://auth/callback',
    openAuthSession: async (url, redirectUri) => {
      calls.push(['openAuthSession', url, redirectUri]);
      return authResult;
    },
    randomUUID: (() => {
      const values = ['raw-nonce', 'apple-state'];
      return () => values.shift() ?? 'extra-random';
    })(),
    sha256: async (value) => {
      calls.push(['sha256', value]);
      return `sha256:${value}`;
    },
    nativeApple: {
      isAvailable: async () => true,
      signIn: async (input) => {
        calls.push(['appleSignIn', input]);
        return appleCredential ?? {
          identityToken: 'apple-id-token',
          authorizationCode: 'apple-one-time-code',
          state: 'apple-state',
        };
      },
    },
  };
  return {
    dependencies,
    calls,
    transient: transientFixture,
    operationJournal,
    operationStorage,
    journalWrites,
  };
}

function createNamedGlobalLock(): {
  lock: OAuthOperationGlobalLock;
  names: string[];
} {
  const tails = new Map<string, Promise<void>>();
  const names: string[] = [];
  return {
    names,
    lock: async <T>(name: string, operation: () => Promise<T>) => {
      names.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const tail = new Promise<void>((resolve) => { release = resolve; });
      tails.set(name, tail);
      await previous;
      try {
        return await operation();
      } finally {
        release();
        if (tails.get(name) === tail) tails.delete(name);
      }
    },
  };
}

describe('account OAuth callback parser', () => {
  test('accepts a PKCE code without exposing fragment tokens', () => {
    expect(parseAccountOAuthCallback('recoto://auth/callback?code=abc')).toEqual({
      status: 'code',
      code: 'abc',
    });
    expect(() =>
      parseAccountOAuthCallback('recoto://auth/callback#access_token=secret'),
    ).toThrow(AccountAuthError);
  });

  test('accepts only expected OAuth error fields', () => {
    expect(
      parseAccountOAuthCallback(
        'recoto://auth/callback?error=access_denied&error_code=identity_already_exists&error_description=Used',
      ),
    ).toEqual({
      status: 'error',
      error: 'access_denied',
      errorCode: 'identity_already_exists',
      description: 'Used',
    });
    expect(() =>
      parseAccountOAuthCallback('recoto://auth/callback?code=abc&refresh_token=secret'),
    ).toThrow(/unexpected/i);
  });
});

describe('Supabase backup auth gateway', () => {
  test('uses hosted Google OAuth without profile scope and exchanges PKCE on the main client', async () => {
    const main = createClientFixture();
    const transient = createClientFixture({
      userId: 'empty-transient',
      anonymous: false,
      identityProviders: ['apple'],
      functionResults: {
        'apple-credential-status': { hasIdentity: true, hasCredential: true },
      },
    });
    const fixture = createDependencies({ main, transient });
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await expect(gateway.linkIdentity('google', ['openid', 'email'])).resolves.toEqual({
      status: 'linked',
      userId: 'guest-1',
    });

    expect(main.calls).toContainEqual([
      'linkIdentity',
      {
        provider: 'google',
        options: {
          redirectTo: 'recoto://auth/callback',
          scopes: 'openid email',
          skipBrowserRedirect: true,
        },
      },
    ]);
    expect(fixture.calls).toContainEqual([
      'openAuthSession',
      'https://auth.example/authorize?state=sdk-state',
      'recoto://auth/callback',
    ]);
    expect(main.calls).toContainEqual(['exchangeCodeForSession', 'pkce-code']);
  });

  test('recognizes only the stable identity_already_exists error code', async () => {
    const main = createClientFixture({ linkErrorCode: 'identity_already_exists' });
    const fixture = createDependencies({ main });
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await expect(gateway.linkIdentity('google', [])).resolves.toEqual({
      status: 'identity-owned',
    });

    const similar = createClientFixture({ linkErrorCode: 'unexpected_failure' });
    const similarGateway = createSupabaseAuthGateway(createDependencies({ main: similar }).dependencies);
    await expect(similarGateway.linkIdentity('google', [])).rejects.toThrow(AccountAuthError);
  });

  test('resumes an identity-owned callback after a process restart without starting OAuth again', async () => {
    const main = createClientFixture({ exchangeErrorCode: 'identity_already_exists' });
    const fixture = createDependencies({ main });

    await expect(createSupabaseAuthGateway(fixture.dependencies).linkIdentity('google', []))
      .resolves.toEqual({ status: 'identity-owned' });
    await expect(fixture.operationJournal.read()).resolves.toEqual(expect.objectContaining({
      stage: 'identity-owned',
      expectedUserId: 'guest-1',
    }));

    const restarted = createSupabaseAuthGateway(fixture.dependencies);
    await expect(restarted.resumePendingOperation()).resolves.toEqual({ status: 'pending' });
    await expect(restarted.linkIdentity('google', [])).resolves.toEqual({
      status: 'identity-owned',
    });
    expect(main.calls.filter(([name]) => name === 'linkIdentity')).toHaveLength(1);
  });

  test('provider cancellation leaves the main session untouched', async () => {
    const main = createClientFixture();
    const fixture = createDependencies({ main, authResult: { type: 'cancel' } });
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await expect(gateway.linkIdentity('google', [])).resolves.toEqual({ status: 'cancelled' });
    expect(main.calls.some(([name]) => name === 'exchangeCodeForSession')).toBe(false);
    expect(main.calls.some(([name]) => name === 'setSession')).toBe(false);
  });

  test('native Apple uses a hashed request nonce and the raw nonce for linking', async () => {
    const main = createClientFixture();
    const fixture = createDependencies({ main });
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await gateway.linkIdentity('apple', []);

    expect(fixture.calls).toContainEqual(['sha256', 'raw-nonce']);
    expect(fixture.calls).toContainEqual([
      'appleSignIn',
      { nonce: 'sha256:raw-nonce', state: 'apple-state', requestedScopes: [] },
    ]);
    expect(main.calls).toContainEqual([
      'linkIdentity',
      { provider: 'apple', token: 'apple-id-token', nonce: 'raw-nonce' },
    ]);
    expect(main.calls).toContainEqual([
      'invoke',
      'store-apple-token',
      {
        authorizationCode: 'apple-one-time-code',
        expectedNonceHash: 'sha256:raw-nonce',
      },
    ]);
  });

  test('rejects an Apple state mismatch before sending credentials to Supabase', async () => {
    const main = createClientFixture();
    const fixture = createDependencies({
      main,
      appleCredential: {
        identityToken: 'apple-id-token',
        authorizationCode: 'apple-code',
        state: 'wrong-state',
      },
    });

    await expect(createSupabaseAuthGateway(fixture.dependencies).linkIdentity('apple', [])).rejects.toThrow(
      /state/i,
    );
    expect(main.calls.some(([name]) => name === 'linkIdentity')).toBe(false);
    expect(main.calls.some(([name]) => name === 'invoke')).toBe(false);
  });

  test('requires the one-time Apple authorization code before linking the identity', async () => {
    const main = createClientFixture();
    const fixture = createDependencies({
      main,
      appleCredential: {
        identityToken: 'apple-id-token',
        authorizationCode: null,
        state: 'apple-state',
      },
    });

    await expect(
      createSupabaseAuthGateway(fixture.dependencies).linkIdentity('apple', []),
    ).rejects.toThrow(/authorization code/i);
    expect(main.calls.some(([name]) => name === 'linkIdentity')).toBe(false);
    expect(main.calls.some(([name]) => name === 'invoke')).toBe(false);
  });

  test('journals a repair state when Apple links but credential storage fails', async () => {
    const main = createClientFixture({
      functionErrorCodes: { 'store-apple-token': 'temporarily_unavailable' },
    });
    const transient = createClientFixture({
      userId: 'empty-transient',
      anonymous: false,
      identityProviders: ['apple'],
      functionResults: {
        'apple-credential-status': { hasIdentity: true, hasCredential: true },
      },
    });
    const fixture = createDependencies({ main, transient });

    await expect(
      createSupabaseAuthGateway(fixture.dependencies).linkIdentity('apple', []),
    ).rejects.toMatchObject({ code: 'apple-token-storage' });

    await expect(fixture.operationJournal.read()).resolves.toEqual(expect.objectContaining({
      kind: 'apple-credential-repair',
      stage: 'credential-repair-required',
      provider: 'apple',
      expectedUserId: 'guest-1',
      apple: { expectedNonceHash: 'sha256:raw-nonce' },
    }));
    expect(JSON.stringify(await fixture.operationJournal.read())).not.toContain('apple-one-time-code');
  });

  test('recovers a committed Apple credential after its function response is lost', async () => {
    const functionErrorCodes: Record<string, string> = {
      'store-apple-token': 'transport_lost_after_commit',
    };
    const main = createClientFixture({
      userId: 'guest-1',
      anonymous: false,
      identityProviders: ['apple'],
      functionErrorCodes,
      functionResults: {
        'apple-credential-status': { hasIdentity: true, hasCredential: true },
      },
    });
    const transient = createClientFixture({
      userId: 'empty-transient',
      anonymous: false,
      identityProviders: ['apple'],
      functionResults: {
        'apple-credential-status': { hasIdentity: true, hasCredential: true },
      },
    });
    const fixture = createDependencies({ main, transient });
    const signIn = jest.fn(fixture.dependencies.nativeApple.signIn);
    fixture.dependencies.nativeApple.signIn = signIn;
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await expect(gateway.linkIdentity('apple', [])).rejects.toMatchObject({
      code: 'apple-token-storage',
    });
    delete functionErrorCodes['store-apple-token'];

    await expect(gateway.resumePendingOperation()).resolves.toEqual(expect.objectContaining({
      status: 'resumed',
      userId: 'guest-1',
      provider: 'apple',
    }));
    expect(transient.calls).toContainEqual(['invoke', 'apple-credential-status', undefined]);
    expect(transient.calls.findIndex(([name]) => name === 'setSession')).toBeLessThan(
      transient.calls.findIndex(([, name]) => name === 'apple-credential-status'),
    );
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(main.calls.filter(([, name]) => name === 'store-apple-token')).toHaveLength(1);
    await expect(fixture.operationJournal.read()).resolves.toBeNull();
  });

  test('checks a repair credential before direct reauthentication starts Apple again', async () => {
    const functionErrorCodes: Record<string, string> = {
      'store-apple-token': 'transport_lost_after_commit',
    };
    const main = createClientFixture({
      userId: 'guest-1',
      anonymous: false,
      identityProviders: ['apple'],
      functionErrorCodes,
      functionResults: {
        'apple-credential-status': { hasIdentity: true, hasCredential: true },
      },
    });
    const transient = createClientFixture({
      userId: 'empty-transient',
      anonymous: false,
      identityProviders: ['apple'],
      functionResults: {
        'apple-credential-status': { hasIdentity: true, hasCredential: true },
      },
    });
    const fixture = createDependencies({ main, transient });
    const signIn = jest.fn(fixture.dependencies.nativeApple.signIn);
    fixture.dependencies.nativeApple.signIn = signIn;
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await expect(gateway.linkIdentity('apple', [])).rejects.toMatchObject({
      code: 'apple-token-storage',
    });
    delete functionErrorCodes['store-apple-token'];

    await expect(gateway.reauthenticate('apple', 'guest-1')).resolves.toEqual({
      status: 'reauthenticated',
      userId: 'guest-1',
      accessToken: 'access-guest-1',
    });
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(main.calls.filter(([, name]) => name === 'store-apple-token')).toHaveLength(1);
    await expect(fixture.operationJournal.read()).resolves.toBeNull();
  });

  test('detects a native Apple link committed before its deletion credential was journaled', async () => {
    const main = createClientFixture({
      userId: 'guest-1',
      anonymous: false,
      identityProviders: ['apple'],
      functionResults: {
        'apple-credential-status': { hasIdentity: true, hasCredential: false },
      },
    });
    const fixture = createDependencies({ main });
    const operation = await fixture.operationJournal.begin({
      kind: 'main-link',
      provider: 'apple',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
    });
    await fixture.operationJournal.saveAppleNonce(operation.operationId, 'hashed-nonce');

    await expect(createSupabaseAuthGateway(fixture.dependencies).resumePendingOperation())
      .resolves.toEqual({ status: 'repair-required', userId: 'guest-1', provider: 'apple' });
    expect(main.calls).toContainEqual(['invoke', 'apple-credential-status', undefined]);
    await expect(fixture.operationJournal.read()).resolves.toEqual(expect.objectContaining({
      kind: 'apple-credential-repair',
      stage: 'credential-repair-required',
      expectedUserId: 'guest-1',
    }));
  });

  test('recovers a transient Apple sign-in committed before credential repair journaling', async () => {
    const main = createClientFixture({ userId: 'guest-1' });
    const transient = createClientFixture({
      userId: 'account-9',
      anonymous: false,
      identityProviders: ['apple'],
      functionResults: {
        'apple-credential-status': { hasIdentity: true, hasCredential: false },
      },
    });
    const fixture = createDependencies({ main, transient });
    const operation = await fixture.operationJournal.begin({
      kind: 'transient-merge',
      provider: 'apple',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
      transientStorageKey: 'transient-operation-1',
      intent: { intentId: 'intent-1', nonce: 'nonce-1' },
    });
    await fixture.operationJournal.saveAppleNonce(operation.operationId, 'hashed-nonce');

    await expect(createSupabaseAuthGateway(fixture.dependencies).resumePendingOperation())
      .resolves.toEqual({ status: 'repair-required', userId: 'account-9', provider: 'apple' });
    expect(transient.calls).toContainEqual(['invoke', 'apple-credential-status', undefined]);
    await expect(fixture.operationJournal.read()).resolves.toEqual(expect.objectContaining({
      kind: 'apple-credential-repair',
      sourceUserId: 'guest-1',
      expectedUserId: 'account-9',
    }));
  });

  test('clears an interrupted native Apple prompt when no identity was committed', async () => {
    const main = createClientFixture({ userId: 'guest-1' });
    const fixture = createDependencies({ main });
    const operation = await fixture.operationJournal.begin({
      kind: 'main-link',
      provider: 'apple',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
    });
    await fixture.operationJournal.saveAppleNonce(operation.operationId, 'hashed-nonce');

    await expect(createSupabaseAuthGateway(fixture.dependencies).resumePendingOperation())
      .resolves.toEqual({ status: 'none' });
    await expect(fixture.operationJournal.read()).resolves.toBeNull();
  });

  test('repairs a linked Apple credential with a fresh isolated same-UID sign-in', async () => {
    const functionErrorCodes: Record<string, string> = {
      'store-apple-token': 'temporarily_unavailable',
    };
    const main = createClientFixture({
      userId: 'guest-1',
      anonymous: false,
      identityProviders: ['apple'],
      functionErrorCodes,
      functionResults: {
        'apple-credential-status': { hasIdentity: true, hasCredential: false },
      },
    });
    const transient = createClientFixture({
      userId: 'empty-transient',
      idTokenUserId: 'guest-1',
      anonymous: false,
      identityProviders: ['apple'],
      functionResults: {
        'apple-credential-status': { hasIdentity: true, hasCredential: false },
      },
    });
    const fixture = createDependencies({ main, transient });
    fixture.dependencies.nativeApple.signIn = async (input) => ({
      identityToken: 'apple-id-token',
      authorizationCode: 'fresh-apple-code',
      state: input.state,
    });
    const gateway = createSupabaseAuthGateway(fixture.dependencies);
    await expect(gateway.linkIdentity('apple', [])).rejects.toMatchObject({
      code: 'apple-token-storage',
    });
    delete functionErrorCodes['store-apple-token'];

    await expect(gateway.reauthenticate('apple', 'guest-1')).resolves.toEqual({
      status: 'reauthenticated',
      userId: 'guest-1',
      accessToken: 'access-guest-1',
    });
    expect(transient.calls).toContainEqual([
      'invoke',
      'store-apple-token',
      expect.objectContaining({ authorizationCode: 'fresh-apple-code' }),
    ]);
    await expect(fixture.operationJournal.read()).resolves.toBeNull();
  });

  test('lets a fresh Apple proof continue account deletion when credential storage needs repair', async () => {
    const main = createClientFixture({
      userId: 'account-9',
      anonymous: false,
      identityProviders: ['apple'],
    });
    const transient = createClientFixture({
      userId: 'account-9',
      anonymous: false,
      identityProviders: ['apple'],
      functionErrorCodes: { 'store-apple-token': 'apple_credential_store_repair_required' },
    });
    const fixture = createDependencies({ main, transient });
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await expect(gateway.reauthenticate('apple', 'account-9', {
      purpose: 'account-deletion',
    })).resolves.toEqual({
      status: 'reauthenticated',
      userId: 'account-9',
      accessToken: 'access-account-9',
    });
    expect(transient.calls).toContainEqual([
      'invoke',
      'store-apple-token',
      expect.objectContaining({ authorizationCode: 'apple-one-time-code' }),
    ]);
    expect(main.calls).toContainEqual([
      'setSession',
      { access_token: 'access-account-9', refresh_token: 'refresh-account-9' },
    ]);
    await expect(fixture.operationJournal.read()).resolves.toBeNull();
  });

  test('treats the native Apple cancel code as cancellation and preserves the main session', async () => {
    const main = createClientFixture();
    const fixture = createDependencies({ main });
    fixture.dependencies.nativeApple.signIn = async () => {
      throw Object.assign(new Error('native dialog closed'), {
        code: 'ERR_REQUEST_CANCELED',
      });
    };

    await expect(
      createSupabaseAuthGateway(fixture.dependencies).linkIdentity('apple', []),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(main.calls.some(([name]) => name === 'linkIdentity')).toBe(false);
    expect(main.calls.some(([name]) => name === 'setSession')).toBe(false);
  });

  test('authenticates an existing identity only on a transient client', async () => {
    const main = createClientFixture();
    const transient = createClientFixture({
      userId: 'empty-transient',
      exchangeUserId: 'account-9',
      anonymous: false,
    });
    const fixture = createDependencies({ main, transient });
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await expect(
      gateway.authenticateExistingIdentity('google', ['openid'], {
        intentId: 'intent-1',
        nonce: 'merge-nonce',
      }),
    ).resolves.toEqual({
      status: 'authenticated',
      userId: 'account-9',
      accessToken: 'access-account-9',
      refreshToken: 'refresh-account-9',
    });

    expect(fixture.calls).toContainEqual([
      'createTransientClient',
      expect.stringMatching(/^recoto-transient-operation-/),
    ]);
    expect(transient.calls).toContainEqual(['exchangeCodeForSession', 'pkce-code']);
    expect(main.calls.some(([name]) => name === 'exchangeCodeForSession')).toBe(false);
    expect(main.calls.some(([name]) => name === 'setSession')).toBe(false);
  });

  test('stores an existing Apple account code with its verified nonce on the transient client', async () => {
    const main = createClientFixture();
    const transient = createClientFixture({
      userId: 'empty-transient',
      idTokenUserId: 'account-9',
      anonymous: false,
    });
    const fixture = createDependencies({ main, transient });
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await expect(
      gateway.authenticateExistingIdentity('apple', [], {
        intentId: 'intent-1',
        nonce: 'merge-nonce',
      }),
    ).resolves.toEqual({
      status: 'authenticated',
      userId: 'account-9',
      accessToken: 'access-account-9',
      refreshToken: 'refresh-account-9',
    });
    expect(transient.calls).toContainEqual([
      'invoke',
      'store-apple-token',
      {
        authorizationCode: 'apple-one-time-code',
        expectedNonceHash: 'sha256:raw-nonce',
      },
    ]);
    expect(main.calls.some(([name]) => name === 'invoke')).toBe(false);
  });

  test('completes the merge as the transient target before activating the main session', async () => {
    const main = createClientFixture();
    const transient = createClientFixture({
      userId: 'empty-transient',
      exchangeUserId: 'account-9',
      anonymous: false,
      functionResults: {
        'complete-account-merge': { userId: 'account-9' },
      },
    });
    const fixture = createDependencies({ main, transient });
    const gateway = createSupabaseAuthGateway(fixture.dependencies);
    const intent = { intentId: 'intent-1', nonce: 'merge-nonce' };
    const target = await gateway.authenticateExistingIdentity('google', [], intent);
    if (target.status !== 'authenticated') throw new Error('expected authenticated fixture');

    await expect(
      gateway.completeMerge({
        intentId: intent.intentId,
        nonce: intent.nonce,
        sourceUserId: 'guest-1',
        targetUserId: target.userId,
        targetAccessToken: target.accessToken,
      }),
    ).resolves.toEqual({ userId: 'account-9' });
    expect(transient.calls).toContainEqual([
      'invoke',
      'complete-account-merge',
      { intentId: 'intent-1', nonce: 'merge-nonce', sourceUserId: 'guest-1' },
    ]);
    expect(main.calls.some(([name]) => name === 'setSession')).toBe(false);

    await gateway.activateSession(target);
    expect(main.calls).toContainEqual([
      'setSession',
      { access_token: 'access-account-9', refresh_token: 'refresh-account-9' },
    ]);
    await expect(fixture.operationJournal.read()).resolves.toBeNull();
  });

  test('lets exactly one consumer exchange a main-link callback', async () => {
    const main = createClientFixture();
    const fixture = createDependencies({ main });
    const operation = await fixture.operationJournal.begin({
      kind: 'main-link',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
    });
    await fixture.operationJournal.markAwaitingCallback(operation.operationId);
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await Promise.all([
      gateway.consumeOAuthCallback('recoto://auth/callback?code=one-code', 'opener'),
      gateway.consumeOAuthCallback('recoto://auth/callback?code=one-code', 'route'),
    ]);

    expect(main.calls.filter(([name]) => name === 'exchangeCodeForSession')).toEqual([
      ['exchangeCodeForSession', 'one-code'],
    ]);
  });

  test('holds an origin-wide callback lock through exchange and durable journal completion', async () => {
    const main = createClientFixture();
    const fixture = createDependencies({ main, platform: 'web' });
    const global = createNamedGlobalLock();
    let now = 1_000;
    const firstJournal = createOAuthOperationJournal({
      storage: fixture.operationStorage,
      now: () => now,
      randomUUID: () => 'operation-long-exchange',
      runtimeId: 'tab-a',
      withGlobalLock: global.lock,
    });
    const secondJournal = createOAuthOperationJournal({
      storage: fixture.operationStorage,
      now: () => now,
      randomUUID: () => 'unused-operation',
      runtimeId: 'tab-b',
      withGlobalLock: global.lock,
    });
    const operation = await firstJournal.begin({
      kind: 'main-link',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
    });
    await firstJournal.markAwaitingCallback(operation.operationId);

    let releaseExchange: () => void = () => undefined;
    let exchangeStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { exchangeStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseExchange = resolve; });
    const originalExchange = main.client.auth.exchangeCodeForSession;
    main.client.auth.exchangeCodeForSession = jest.fn(async (code) => {
      exchangeStarted();
      await blocked;
      return originalExchange(code);
    });
    const first = createSupabaseAuthGateway({
      ...fixture.dependencies,
      operationJournal: firstJournal,
      withOAuthCallbackLock: global.lock,
    });
    const second = createSupabaseAuthGateway({
      ...fixture.dependencies,
      operationJournal: secondJournal,
      withOAuthCallbackLock: global.lock,
    });

    const firstResult = first.consumeOAuthCallback(
      'recoto://auth/callback?code=long-code',
      'opener',
    );
    await started;
    now += OAUTH_CALLBACK_CLAIM_LEASE_MS + 1;
    const secondResult = second.consumeOAuthCallback(
      'recoto://auth/callback?code=long-code',
      'route',
    );
    await Promise.resolve();
    await Promise.resolve();

    let preReleaseAssertion: unknown = null;
    try {
      expect(main.client.auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    } catch (error) {
      preReleaseAssertion = error;
    } finally {
      releaseExchange();
    }
    if (preReleaseAssertion) {
      await Promise.allSettled([firstResult, secondResult]);
      throw preReleaseAssertion;
    }
    await expect(firstResult).resolves.toEqual(expect.objectContaining({ status: 'main-linked' }));
    await expect(secondResult).rejects.toMatchObject({ code: 'operation-unavailable' });
    expect(main.client.auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(new Set(global.names).size).toBeGreaterThanOrEqual(2);
  });

  test('a transient merge callback route never exchanges on the main client', async () => {
    const main = createClientFixture();
    const transient = createClientFixture({
      userId: 'empty-transient',
      exchangeUserId: 'account-9',
      anonymous: false,
    });
    const fixture = createDependencies({ main, transient });
    const operation = await fixture.operationJournal.begin({
      kind: 'transient-merge',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
      transientStorageKey: 'transient-operation-1',
      intent: { intentId: 'intent-1', nonce: 'nonce-1' },
    });
    await fixture.operationJournal.markAwaitingCallback(operation.operationId);
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await expect(
      gateway.consumeOAuthCallback('recoto://auth/callback?code=target-code', 'route'),
    ).resolves.toEqual(expect.objectContaining({
      status: 'target-authenticated',
      userId: 'account-9',
    }));

    expect(transient.calls).toContainEqual(['exchangeCodeForSession', 'target-code']);
    expect(main.calls.some(([name]) => name === 'exchangeCodeForSession')).toBe(false);
    await expect(fixture.operationJournal.read()).resolves.toEqual(expect.objectContaining({
      stage: 'target-authenticated',
      targetSession: expect.objectContaining({ userId: 'account-9' }),
    }));
  });

  test('rejects a callback from another destination before claiming or exchanging it', async () => {
    const main = createClientFixture();
    const fixture = createDependencies({ main });
    const operation = await fixture.operationJournal.begin({
      kind: 'main-link',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
    });
    await fixture.operationJournal.markAwaitingCallback(operation.operationId);

    await expect(
      createSupabaseAuthGateway(fixture.dependencies).consumeOAuthCallback(
        'https://evil.example/auth/callback?code=stolen',
        'route',
      ),
    ).rejects.toMatchObject({ code: 'invalid-callback' });
    expect(main.calls.some(([name]) => name === 'exchangeCodeForSession')).toBe(false);
    const stillAwaiting = await fixture.operationJournal.read();
    expect(stillAwaiting).toEqual(expect.objectContaining({ stage: 'awaiting-callback' }));
    expect(stillAwaiting).not.toHaveProperty('callbackClaim');
  });

  test('resumes a completed merge after process death and clears only after main-session verification', async () => {
    const main = createClientFixture({ userId: 'guest-1' });
    const fixture = createDependencies({ main });
    const operation = await fixture.operationJournal.begin({
      kind: 'transient-merge',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
      transientStorageKey: 'transient-operation-1',
      intent: { intentId: 'intent-1', nonce: 'nonce-1' },
    });
    await fixture.operationJournal.saveTargetSession(operation.operationId, {
      userId: 'account-9',
      accessToken: 'access-account-9',
      refreshToken: 'refresh-account-9',
    });
    await fixture.operationJournal.markMergeCompleted(operation.operationId, 'account-9');

    await expect(createSupabaseAuthGateway(fixture.dependencies).resumePendingOperation())
      .resolves.toEqual({
        status: 'resumed',
        userId: 'account-9',
        provider: 'google',
        email: null,
      });
    expect(main.calls).toContainEqual([
      'setSession',
      { access_token: 'access-account-9', refresh_token: 'refresh-account-9' },
    ]);
    expect(main.calls).toContainEqual(['getSession']);
    expect(main.calls).toContainEqual(['getUser']);
    await expect(fixture.operationJournal.read()).resolves.toBeNull();
  });

  test('keeps a completed merge resumable when main session persistence fails', async () => {
    const main = createClientFixture({ userId: 'guest-1' });
    const fixture = createDependencies({ main });
    const operation = await fixture.operationJournal.begin({
      kind: 'transient-merge',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
      transientStorageKey: 'transient-operation-1',
      intent: { intentId: 'intent-1', nonce: 'nonce-1' },
    });
    await fixture.operationJournal.saveTargetSession(operation.operationId, {
      userId: 'account-9',
      accessToken: 'access-account-9',
      refreshToken: 'refresh-account-9',
    });
    await fixture.operationJournal.markMergeCompleted(operation.operationId, 'account-9');
    const workingSetSession = main.client.auth.setSession;
    main.client.auth.setSession = jest.fn(async () => {
      throw new Error('localStorage quota exceeded');
    });

    await expect(
      createSupabaseAuthGateway(fixture.dependencies).resumePendingOperation(),
    ).rejects.toThrow('localStorage quota exceeded');
    await expect(fixture.operationJournal.read()).resolves.toEqual(expect.objectContaining({
      stage: 'merge-completed',
      targetSession: expect.objectContaining({ userId: 'account-9' }),
    }));

    main.client.auth.setSession = workingSetSession;
    await expect(
      createSupabaseAuthGateway(fixture.dependencies).resumePendingOperation(),
    ).resolves.toEqual(expect.objectContaining({ status: 'resumed', userId: 'account-9' }));
    await expect(fixture.operationJournal.read()).resolves.toBeNull();
  });

  test('does not exchange a callback again after a persisted claim', async () => {
    const main = createClientFixture();
    const fixture = createDependencies({ main });
    const operation = await fixture.operationJournal.begin({
      kind: 'main-link',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
    });
    await fixture.operationJournal.markAwaitingCallback(operation.operationId);
    await fixture.operationJournal.claimCallback(operation.operationId, 'opener');

    await expect(
      createSupabaseAuthGateway(fixture.dependencies).consumeOAuthCallback(
        'recoto://auth/callback?code=already-claimed',
        'route',
      ),
    ).rejects.toMatchObject({ code: 'callback-pending' });
    expect(main.calls.some(([name]) => name === 'exchangeCodeForSession')).toBe(false);
  });

  test('retries a killed callback claim in the same process after its durable lease expires', async () => {
    const main = createClientFixture();
    const fixture = createDependencies({ main });
    let now = 1_000;
    const beforeKill = createOAuthOperationJournal({
      storage: fixture.operationStorage,
      now: () => now,
      randomUUID: () => 'operation-killed-after-claim',
      runtimeId: 'runtime-before-kill',
    });
    const operation = await beforeKill.begin({
      kind: 'main-link',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
    });
    await beforeKill.markAwaitingCallback(operation.operationId);
    await beforeKill.saveCallback(
      operation.operationId,
      'recoto://auth/callback?code=reclaim-after-lease',
    );
    await beforeKill.claimCallback(operation.operationId, 'opener');

    const afterRestart = createOAuthOperationJournal({
      storage: fixture.operationStorage,
      now: () => now,
      randomUUID: () => 'unused-operation',
      runtimeId: 'runtime-after-kill',
    });
    const gateway = createSupabaseAuthGateway({
      ...fixture.dependencies,
      operationJournal: afterRestart,
    });

    await expect(gateway.resumePendingOperation()).resolves.toEqual({ status: 'pending' });
    expect(main.calls.some(([name]) => name === 'exchangeCodeForSession')).toBe(false);

    now += OAUTH_CALLBACK_CLAIM_LEASE_MS + 1;
    await expect(gateway.resumePendingOperation()).resolves.toEqual(expect.objectContaining({
      status: 'resumed',
      userId: 'guest-1',
      provider: 'google',
    }));
    expect(main.calls.filter(([name]) => name === 'exchangeCodeForSession')).toEqual([
      ['exchangeCodeForSession', 'reclaim-after-lease'],
    ]);
  });

  test('does not mistake an uncompleted main-link claim for a linked identity on resume', async () => {
    const main = createClientFixture({ userId: 'guest-1' });
    const fixture = createDependencies({ main });
    const operation = await fixture.operationJournal.begin({
      kind: 'main-link',
      provider: 'google',
      expectedUserId: 'guest-1',
      redirectUri: 'recoto://auth/callback',
    });
    await fixture.operationJournal.markAwaitingCallback(operation.operationId);
    await fixture.operationJournal.claimCallback(operation.operationId, 'route');

    await expect(createSupabaseAuthGateway(fixture.dependencies).resumePendingOperation())
      .resolves.toEqual({ status: 'pending' });
    await expect(fixture.operationJournal.read()).resolves.toEqual(expect.objectContaining({
      stage: 'callback-claimed',
    }));
  });

  test('resumes a popup-inboxed callback after the opener is terminated before consuming it', async () => {
    const main = createClientFixture({ userId: 'account-9', anonymous: false });
    const transient = createClientFixture({
      userId: 'empty-transient',
      exchangeUserId: 'account-9',
      anonymous: false,
    });
    const fixture = createDependencies({ main, transient });
    const operation = await fixture.operationJournal.begin({
      kind: 'reauth',
      provider: 'google',
      expectedUserId: 'account-9',
      redirectUri: 'recoto://auth/callback',
      transientStorageKey: 'transient-operation-1',
    });
    await fixture.operationJournal.markAwaitingCallback(operation.operationId);
    await inboxAccountOAuthCallback(
      fixture.operationJournal,
      'recoto://auth/callback?code=durable-code',
    );

    await expect(createSupabaseAuthGateway(fixture.dependencies).resumePendingOperation())
      .resolves.toEqual(expect.objectContaining({ status: 'resumed', userId: 'account-9' }));
    expect(transient.calls).toContainEqual(['exchangeCodeForSession', 'durable-code']);
    await expect(fixture.operationJournal.read()).resolves.toBeNull();
  });

  test('recovers a provider-verified transient session when exchange committed before journaling', async () => {
    const main = createClientFixture({ userId: 'account-9', anonymous: false });
    const transient = createClientFixture({
      userId: 'account-9',
      anonymous: false,
      identityProviders: ['google'],
    });
    const fixture = createDependencies({ main, transient });
    const operation = await fixture.operationJournal.begin({
      kind: 'reauth',
      provider: 'google',
      expectedUserId: 'account-9',
      redirectUri: 'recoto://auth/callback',
      transientStorageKey: 'transient-operation-1',
    });
    await fixture.operationJournal.markAwaitingCallback(operation.operationId);
    await fixture.operationJournal.saveCallback(
      operation.operationId,
      'recoto://auth/callback?code=already-consumed-code',
    );
    await fixture.operationJournal.claimCallback(operation.operationId, 'opener');
    fixture.dependencies.operationJournal = createOAuthOperationJournal({
      storage: fixture.operationStorage,
      now: () => 1_001,
      randomUUID: () => 'unused-operation',
      runtimeId: 'runtime-after-process-kill',
    });

    await expect(createSupabaseAuthGateway(fixture.dependencies).resumePendingOperation())
      .resolves.toEqual(expect.objectContaining({ status: 'resumed', userId: 'account-9' }));
    expect(transient.calls).toContainEqual(['getSession']);
    expect(transient.calls).toContainEqual(['getUser']);
    expect(transient.calls.some(([name]) => name === 'exchangeCodeForSession')).toBe(false);
  });

  test('reauthenticates in isolation even when the old main session cannot be read', async () => {
    const main = createClientFixture({ userId: 'account-9' });
    const originalGetUser = main.client.auth.getUser;
    let activated = false;
    main.client.auth.getUser = jest.fn(async () => {
      if (!activated) {
        return { data: { user: null }, error: { code: 'session_expired', message: 'expired' } };
      }
      return originalGetUser();
    });
    const originalSetSession = main.client.auth.setSession;
    main.client.auth.setSession = jest.fn(async (tokens) => {
      const result = await originalSetSession(tokens);
      activated = true;
      return result;
    });
    const transient = createClientFixture({
      userId: 'empty-transient',
      exchangeUserId: 'account-9',
      anonymous: false,
      providerToken: 'google-immediate-provider-token',
    });
    const fixture = createDependencies({ main, transient });
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await expect(gateway.reauthenticate('google', 'account-9')).resolves.toEqual({
      status: 'reauthenticated',
      userId: 'account-9',
      accessToken: 'access-account-9',
      providerToken: 'google-immediate-provider-token',
    });
    expect(transient.calls).toContainEqual(['exchangeCodeForSession', 'pkce-code']);
    expect(main.calls.some(([name]) => name === 'exchangeCodeForSession')).toBe(false);
    expect(main.client.auth.getUser).toHaveBeenCalledTimes(1);
    expect(fixture.journalWrites.join('\n')).not.toContain('google-immediate-provider-token');
  });

  test('never switches the main account when isolated reauthentication returns another UID', async () => {
    const main = createClientFixture({ userId: 'account-9' });
    const transient = createClientFixture({
      userId: 'empty-transient',
      exchangeUserId: 'other-account',
      anonymous: false,
    });
    const fixture = createDependencies({ main, transient });
    const gateway = createSupabaseAuthGateway(fixture.dependencies);

    await expect(gateway.reauthenticate('google', 'account-9')).rejects.toThrow(/match|一致/i);
    expect(main.calls.some(([name]) => name === 'setSession')).toBe(false);
  });
});
