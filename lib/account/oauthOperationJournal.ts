import type { BackupIdentityProvider, ExistingProviderSession, MergeIntent } from './connectBackupIdentity';

export const OAUTH_OPERATION_TTL_MS = 10 * 60 * 1_000;
export const OAUTH_CALLBACK_CLAIM_LEASE_MS = 15 * 1_000;
export const OAUTH_OPERATION_STORAGE_KEY = 'recoto.account.oauth-operation.v1';
const OAUTH_OPERATION_LOCK_NAME = 'recoto.account.oauth-operation.lock.v1';

const JOURNAL_VERSION = 1;

export type OAuthOperationKind =
  | 'main-link'
  | 'transient-merge'
  | 'reauth'
  | 'apple-credential-repair';

export type OAuthOperationStage =
  | 'awaiting-provider'
  | 'awaiting-callback'
  | 'callback-claimed'
  | 'identity-owned'
  | 'target-authenticated'
  | 'merge-completed'
  | 'credential-repair-required';

export interface OAuthOperationRecord {
  version: 1;
  operationId: string;
  kind: OAuthOperationKind;
  provider: BackupIdentityProvider;
  stage: OAuthOperationStage;
  expectedUserId: string;
  /** Present only while repairing a target Apple credential during a merge. */
  sourceUserId?: string;
  redirectUri: string;
  transientStorageKey?: string;
  intent?: MergeIntent;
  targetSession?: ExistingProviderSession;
  callbackClaim?: {
    consumer: 'opener' | 'route';
    claimedAt: number;
    /** Identifies one running JavaScript process, not a user or credential. */
    runtimeId?: string;
  };
  /** Validated one-time callback, encrypted at rest on native. */
  callback?: {
    url: string;
    receivedAt: number;
  };
  apple?: {
    expectedNonceHash: string;
  };
  createdAt: number;
  expiresAt: number;
}

export interface OAuthOperationStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type OAuthOperationGlobalLock = <T>(
  name: string,
  operation: () => Promise<T>,
) => Promise<T>;

interface WebLockManagerLike {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Uses the browser's origin-wide lock instead of a realm-local mutex. Failing
 * closed on legacy browsers is safer than exchanging the same PKCE code from
 * two tabs and potentially activating the wrong recovery session.
 */
export function createWebOAuthGlobalLock(
  resolveLockManager: () => WebLockManagerLike | null | undefined = () => {
    if (typeof navigator === 'undefined') return null;
    return (navigator as Navigator & { locks?: WebLockManagerLike }).locks;
  },
): OAuthOperationGlobalLock {
  return async (name, operation) => {
    const manager = resolveLockManager();
    if (!manager?.request) {
      throw new Error('Secure cross-tab OAuth locking is unavailable');
    }
    return manager.request(name, { mode: 'exclusive' }, operation);
  };
}

/**
 * Web OAuth must never fall back to an in-memory mutex: independent tabs do
 * not share it. Native has one JavaScript runtime, so no origin-wide lock is
 * required there.
 */
export function createOAuthGlobalLockForPlatform(
  platform: 'web' | 'native',
  resolveLockManager?: () => WebLockManagerLike | null | undefined,
): OAuthOperationGlobalLock | undefined {
  return platform === 'web'
    ? createWebOAuthGlobalLock(resolveLockManager)
    : undefined;
}

export interface BeginOAuthOperationInput {
  kind: Exclude<OAuthOperationKind, 'apple-credential-repair'>;
  provider: BackupIdentityProvider;
  expectedUserId: string;
  redirectUri: string;
  transientStorageKey?: string;
  intent?: MergeIntent;
}

export interface OAuthOperationJournal {
  begin(input: BeginOAuthOperationInput): Promise<OAuthOperationRecord>;
  read(): Promise<OAuthOperationRecord | null>;
  markAwaitingCallback(operationId: string): Promise<OAuthOperationRecord>;
  saveAppleNonce(operationId: string, expectedNonceHash: string): Promise<OAuthOperationRecord>;
  saveCallback(operationId: string, url: string): Promise<OAuthOperationRecord>;
  claimCallback(
    operationId: string,
    consumer: 'opener' | 'route',
  ): Promise<{ status: 'claimed' | 'already-claimed'; operation: OAuthOperationRecord }>;
  markIdentityOwned(operationId: string): Promise<OAuthOperationRecord>;
  setMergeIntent(
    operationId: string,
    sourceUserId: string,
    intent: MergeIntent,
    transientStorageKey: string,
  ): Promise<OAuthOperationRecord>;
  saveTargetSession(
    operationId: string,
    session: Omit<ExistingProviderSession, 'status'>,
  ): Promise<OAuthOperationRecord>;
  markMergeCompleted(operationId: string, targetUserId: string): Promise<OAuthOperationRecord>;
  markAppleCredentialRepair(
    operationId: string,
    input: {
      expectedUserId: string;
      expectedNonceHash: string;
      targetSession?: Omit<ExistingProviderSession, 'status'>;
    },
  ): Promise<OAuthOperationRecord>;
  completeAppleCredentialRepair(
    operationId: string,
    session: Omit<ExistingProviderSession, 'status'>,
  ): Promise<OAuthOperationRecord>;
  clearAfterVerifiedSession(operationId: string, verifiedUserId: string): Promise<void>;
  cancel(operationId: string): Promise<void>;
}

type JournalOptions = {
  storage: OAuthOperationStorage;
  now?: () => number;
  randomUUID: () => string;
  ttlMs?: number;
  storageKey?: string;
  runtimeId?: string;
  withGlobalLock?: OAuthOperationGlobalLock;
};

const storageQueues = new WeakMap<object, Promise<void>>();
const DEFAULT_CALLBACK_RUNTIME_ID =
  globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`OAuth operation journal has invalid ${field}`);
  }
  return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OAuth operation journal has invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function rejectUnexpectedFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
) {
  const allowlist = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowlist.has(key));
  if (unexpected) {
    throw new Error(`OAuth operation journal has unexpected ${field}.${unexpected}`);
  }
}

function parseStoredOperation(raw: string): OAuthOperationRecord {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('OAuth operation journal verification failed');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('OAuth operation journal verification failed');
  }
  const record = decoded as Record<string, unknown>;
  rejectUnexpectedFields(record, [
    'version',
    'operationId',
    'kind',
    'provider',
    'stage',
    'expectedUserId',
    'sourceUserId',
    'redirectUri',
    'transientStorageKey',
    'intent',
    'targetSession',
    'callbackClaim',
    'callback',
    'apple',
    'createdAt',
    'expiresAt',
  ], 'record');
  if (record.version !== JOURNAL_VERSION) {
    throw new Error('OAuth operation journal verification failed');
  }

  const kinds: OAuthOperationKind[] = [
    'main-link',
    'transient-merge',
    'reauth',
    'apple-credential-repair',
  ];
  const stages: OAuthOperationStage[] = [
    'awaiting-provider',
    'awaiting-callback',
    'callback-claimed',
    'identity-owned',
    'target-authenticated',
    'merge-completed',
    'credential-repair-required',
  ];
  if (!kinds.includes(record.kind as OAuthOperationKind)) {
    throw new Error('OAuth operation journal has invalid kind');
  }
  if (record.provider !== 'google' && record.provider !== 'apple') {
    throw new Error('OAuth operation journal has invalid provider');
  }
  if (!stages.includes(record.stage as OAuthOperationStage)) {
    throw new Error('OAuth operation journal has invalid stage');
  }
  if (!Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt)) {
    throw new Error('OAuth operation journal has invalid lifetime');
  }

  const result: OAuthOperationRecord = {
    version: 1,
    operationId: requiredString(record.operationId, 'operationId'),
    kind: record.kind as OAuthOperationKind,
    provider: record.provider,
    stage: record.stage as OAuthOperationStage,
    expectedUserId: requiredString(record.expectedUserId, 'expectedUserId'),
    redirectUri: requiredString(record.redirectUri, 'redirectUri'),
    createdAt: record.createdAt as number,
    expiresAt: record.expiresAt as number,
  };

  if (record.transientStorageKey !== undefined) {
    result.transientStorageKey = requiredString(record.transientStorageKey, 'transientStorageKey');
  }
  if (record.sourceUserId !== undefined) {
    result.sourceUserId = requiredString(record.sourceUserId, 'sourceUserId');
  }
  const intent = optionalRecord(record.intent, 'intent');
  if (intent) {
    rejectUnexpectedFields(intent, ['intentId', 'nonce'], 'intent');
    result.intent = {
      intentId: requiredString(intent.intentId, 'intent.intentId'),
      nonce: requiredString(intent.nonce, 'intent.nonce'),
    };
  }
  const targetSession = optionalRecord(record.targetSession, 'targetSession');
  if (targetSession) {
    rejectUnexpectedFields(
      targetSession,
      ['status', 'userId', 'accessToken', 'refreshToken'],
      'targetSession',
    );
    if (targetSession.status !== 'authenticated') {
      throw new Error('OAuth operation journal has invalid targetSession.status');
    }
    result.targetSession = {
      status: 'authenticated',
      userId: requiredString(targetSession.userId, 'targetSession.userId'),
      accessToken: requiredString(targetSession.accessToken, 'targetSession.accessToken'),
      refreshToken: requiredString(targetSession.refreshToken, 'targetSession.refreshToken'),
    };
  }
  const callbackClaim = optionalRecord(record.callbackClaim, 'callbackClaim');
  if (callbackClaim) {
    rejectUnexpectedFields(callbackClaim, ['consumer', 'claimedAt', 'runtimeId'], 'callbackClaim');
    if (
      (callbackClaim.consumer !== 'opener' && callbackClaim.consumer !== 'route') ||
      !Number.isSafeInteger(callbackClaim.claimedAt)
    ) {
      throw new Error('OAuth operation journal has invalid callbackClaim');
    }
    result.callbackClaim = {
      consumer: callbackClaim.consumer,
      claimedAt: callbackClaim.claimedAt as number,
      ...(callbackClaim.runtimeId !== undefined
        ? { runtimeId: requiredString(callbackClaim.runtimeId, 'callbackClaim.runtimeId') }
        : {}),
    };
  }
  const callback = optionalRecord(record.callback, 'callback');
  if (callback) {
    rejectUnexpectedFields(callback, ['url', 'receivedAt'], 'callback');
    if (!Number.isSafeInteger(callback.receivedAt)) {
      throw new Error('OAuth operation journal has invalid callback');
    }
    const url = requiredString(callback.url, 'callback.url');
    if (url.length > 8192) throw new Error('OAuth operation journal has invalid callback');
    result.callback = { url, receivedAt: callback.receivedAt as number };
  }
  const apple = optionalRecord(record.apple, 'apple');
  if (apple) {
    rejectUnexpectedFields(apple, ['expectedNonceHash'], 'apple');
    result.apple = {
      expectedNonceHash: requiredString(apple.expectedNonceHash, 'apple.expectedNonceHash'),
    };
  }
  return result;
}

export function createOAuthOperationJournal({
  storage,
  now = Date.now,
  randomUUID,
  ttlMs = OAUTH_OPERATION_TTL_MS,
  storageKey = OAUTH_OPERATION_STORAGE_KEY,
  runtimeId = DEFAULT_CALLBACK_RUNTIME_ID,
  withGlobalLock,
}: JournalOptions): OAuthOperationJournal {
  const callbackRuntimeId = requiredString(runtimeId, 'runtimeId');
  function locked<T>(operation: () => Promise<T>): Promise<T> {
    const queueKey = storage as object;
    const previous = storageQueues.get(queueKey) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() =>
      withGlobalLock
        ? withGlobalLock(OAUTH_OPERATION_LOCK_NAME, operation)
        : operation());
    const tail = result.then(() => undefined, () => undefined);
    storageQueues.set(queueKey, tail);
    return result.finally(() => {
      if (storageQueues.get(queueKey) === tail) storageQueues.delete(queueKey);
    });
  }

  async function removeOperationArtifacts(operation: OAuthOperationRecord) {
    if (!operation.transientStorageKey) return;
    for (const key of [
      operation.transientStorageKey,
      `${operation.transientStorageKey}-code-verifier`,
    ]) {
      await storage.removeItem(key);
      if ((await storage.getItem(key)) !== null) {
        throw new Error('OAuth transient storage removal verification failed');
      }
    }
  }

  async function removeVerified(operation: OAuthOperationRecord) {
    await removeOperationArtifacts(operation);
    await storage.removeItem(storageKey);
    if ((await storage.getItem(storageKey)) !== null) {
      throw new Error('OAuth operation journal removal verification failed');
    }
  }

  async function readUnlocked() {
    const raw = await storage.getItem(storageKey);
    if (raw === null) return null;
    const operation = parseStoredOperation(raw);
    const mustRecoverExplicitly =
      operation.stage === 'target-authenticated'
      || operation.stage === 'merge-completed'
      || operation.stage === 'credential-repair-required'
      || (
        operation.provider === 'apple'
        && operation.stage === 'awaiting-provider'
        && Boolean(operation.apple)
      );
    if (operation.expiresAt <= now() && !mustRecoverExplicitly) {
      await removeVerified(operation);
      return null;
    }
    return operation;
  }

  async function writeVerified(operation: OAuthOperationRecord) {
    const encoded = JSON.stringify(operation);
    await storage.setItem(storageKey, encoded);
    const verified = await storage.getItem(storageKey);
    if (verified !== encoded) {
      throw new Error('OAuth operation journal write verification failed');
    }
    return parseStoredOperation(verified);
  }

  async function requireOperation(operationId: string) {
    const operation = await readUnlocked();
    if (!operation || operation.operationId !== operationId) {
      throw new Error('OAuth operation journal operation was not found');
    }
    return operation;
  }

  return {
    begin: (input) =>
      locked(async () => {
        const active = await readUnlocked();
        if (active) throw new Error('An OAuth operation is already in progress');
        const createdAt = now();
        const operationId = requiredString(randomUUID(), 'operationId');
        const operation: OAuthOperationRecord = {
          version: 1,
          operationId,
          kind: input.kind,
          provider: input.provider,
          stage: 'awaiting-provider',
          expectedUserId: requiredString(input.expectedUserId, 'expectedUserId'),
          redirectUri: requiredString(input.redirectUri, 'redirectUri'),
          ...(input.kind === 'transient-merge' || input.kind === 'reauth'
            ? {
                transientStorageKey: requiredString(
                  input.transientStorageKey ?? `recoto-transient-${operationId}`,
                  'transientStorageKey',
                ),
              }
            : input.transientStorageKey
              ? { transientStorageKey: requiredString(input.transientStorageKey, 'transientStorageKey') }
              : {}),
          ...(input.intent ? { intent: input.intent } : {}),
          createdAt,
          expiresAt: createdAt + ttlMs,
        };
        return writeVerified(operation);
      }),

    read: () => locked(readUnlocked),

    markAwaitingCallback: (operationId) =>
      locked(async () => {
        const operation = await requireOperation(operationId);
        if (operation.stage !== 'awaiting-provider') {
          throw new Error('OAuth operation is not awaiting a provider');
        }
        return writeVerified({ ...operation, stage: 'awaiting-callback' });
      }),

    saveAppleNonce: (operationId, expectedNonceHash) =>
      locked(async () => {
        const operation = await requireOperation(operationId);
        if (
          operation.provider !== 'apple' ||
          (operation.stage !== 'awaiting-provider' &&
            operation.stage !== 'credential-repair-required')
        ) {
          throw new Error('Apple OAuth operation was not awaiting a provider');
        }
        return writeVerified({
          ...operation,
          apple: {
            expectedNonceHash: requiredString(expectedNonceHash, 'apple.expectedNonceHash'),
          },
        });
      }),

    saveCallback: (operationId, url) =>
      locked(async () => {
        const operation = await requireOperation(operationId);
        if (
          operation.stage !== 'awaiting-callback'
          && operation.stage !== 'callback-claimed'
        ) {
          throw new Error('OAuth operation is not awaiting a callback');
        }
        const callbackUrl = requiredString(url, 'callback.url');
        if (callbackUrl.length > 8192) {
          throw new Error('OAuth operation journal has invalid callback');
        }
        if (operation.callback && operation.callback.url !== callbackUrl) {
          throw new Error('OAuth operation callback did not match');
        }
        if (operation.callback) return operation;
        return writeVerified({
          ...operation,
          callback: { url: callbackUrl, receivedAt: now() },
        });
      }),

    claimCallback: (operationId, consumer) =>
      locked(async () => {
        const operation = await requireOperation(operationId);
        if (operation.callbackClaim?.runtimeId === callbackRuntimeId) {
          return { status: 'already-claimed' as const, operation };
        }
        if (
          operation.stage === 'callback-claimed'
          && operation.callbackClaim
          && operation.callbackClaim.claimedAt + OAUTH_CALLBACK_CLAIM_LEASE_MS > now()
        ) {
          return { status: 'already-claimed' as const, operation };
        }
        if (
          operation.stage !== 'awaiting-callback'
          && operation.stage !== 'callback-claimed'
        ) {
          throw new Error('OAuth operation is not awaiting a callback');
        }
        const claimed = await writeVerified({
          ...operation,
          stage: 'callback-claimed',
          callbackClaim: { consumer, claimedAt: now(), runtimeId: callbackRuntimeId },
        });
        return { status: 'claimed' as const, operation: claimed };
      }),

    markIdentityOwned: (operationId) =>
      locked(async () => {
        const operation = await requireOperation(operationId);
        if (
          operation.kind !== 'main-link'
          || ![
            'awaiting-provider',
            'awaiting-callback',
            'callback-claimed',
            'identity-owned',
          ].includes(operation.stage)
        ) {
          throw new Error('OAuth operation cannot become an identity-owned merge');
        }
        if (operation.stage === 'identity-owned') return operation;
        return writeVerified({
          ...operation,
          stage: 'identity-owned',
          callbackClaim: undefined,
          callback: undefined,
        });
      }),

    setMergeIntent: (operationId, sourceUserId, intent, transientStorageKey) =>
      locked(async () => {
        const operation = await requireOperation(operationId);
        if (
          operation.kind !== 'main-link'
          || operation.stage !== 'identity-owned'
          || operation.expectedUserId !== sourceUserId
        ) {
          throw new Error('OAuth merge source UID did not match');
        }
        return writeVerified({
          ...operation,
          kind: 'transient-merge',
          stage: 'awaiting-provider',
          callbackClaim: undefined,
          callback: undefined,
          intent: {
            intentId: requiredString(intent.intentId, 'intent.intentId'),
            nonce: requiredString(intent.nonce, 'intent.nonce'),
          },
          transientStorageKey: requiredString(transientStorageKey, 'transientStorageKey'),
        });
      }),

    saveTargetSession: (operationId, session) =>
      locked(async () => {
        const operation = await requireOperation(operationId);
        const targetSession: ExistingProviderSession = {
          status: 'authenticated',
          userId: requiredString(session.userId, 'targetSession.userId'),
          accessToken: requiredString(session.accessToken, 'targetSession.accessToken'),
          refreshToken: requiredString(session.refreshToken, 'targetSession.refreshToken'),
        };
        if (
          (operation.kind === 'reauth' || operation.kind === 'apple-credential-repair') &&
          targetSession.userId !== operation.expectedUserId
        ) {
          throw new Error('OAuth target UID did not match expected UID');
        }
        if (
          operation.kind === 'transient-merge' &&
          targetSession.userId === operation.expectedUserId
        ) {
          throw new Error('OAuth merge target UID must differ from source UID');
        }
        return writeVerified({
          ...operation,
          stage: 'target-authenticated',
          targetSession,
        });
      }),

    markMergeCompleted: (operationId, targetUserId) =>
      locked(async () => {
        const operation = await requireOperation(operationId);
        if (
          operation.kind !== 'transient-merge' ||
          operation.stage !== 'target-authenticated' ||
          operation.targetSession?.userId !== targetUserId
        ) {
          throw new Error('OAuth merge target UID did not match');
        }
        return writeVerified({ ...operation, stage: 'merge-completed' });
      }),

    markAppleCredentialRepair: (operationId, input) =>
      locked(async () => {
        const operation = await requireOperation(operationId);
        if (
          operation.provider !== 'apple' ||
          (operation.kind !== 'transient-merge' && operation.expectedUserId !== input.expectedUserId)
        ) {
          throw new Error('Apple credential repair UID did not match');
        }
        const targetSession = input.targetSession
          ? {
              status: 'authenticated' as const,
              userId: requiredString(input.targetSession.userId, 'targetSession.userId'),
              accessToken: requiredString(input.targetSession.accessToken, 'targetSession.accessToken'),
              refreshToken: requiredString(input.targetSession.refreshToken, 'targetSession.refreshToken'),
            }
          : undefined;
        if (targetSession && targetSession.userId !== input.expectedUserId) {
          throw new Error('Apple credential repair target UID did not match');
        }
        return writeVerified({
          ...operation,
          kind: 'apple-credential-repair',
          stage: 'credential-repair-required',
          expectedUserId: input.expectedUserId,
          ...(operation.kind === 'transient-merge'
            ? { sourceUserId: operation.expectedUserId }
            : {}),
          transientStorageKey:
            operation.transientStorageKey ?? `recoto-transient-${operation.operationId}`,
          callbackClaim: undefined,
          callback: undefined,
          targetSession,
          apple: {
            expectedNonceHash: requiredString(input.expectedNonceHash, 'apple.expectedNonceHash'),
          },
        });
      }),

    completeAppleCredentialRepair: (operationId, session) =>
      locked(async () => {
        const operation = await requireOperation(operationId);
        if (
          operation.kind !== 'apple-credential-repair' ||
          operation.stage !== 'credential-repair-required'
        ) {
          throw new Error('Apple credential repair was not pending');
        }
        const targetSession: ExistingProviderSession = {
          status: 'authenticated',
          userId: requiredString(session.userId, 'targetSession.userId'),
          accessToken: requiredString(session.accessToken, 'targetSession.accessToken'),
          refreshToken: requiredString(session.refreshToken, 'targetSession.refreshToken'),
        };
        if (targetSession.userId !== operation.expectedUserId) {
          throw new Error('Apple credential repair target UID did not match');
        }
        if (operation.sourceUserId && operation.intent) {
          return writeVerified({
            ...operation,
            kind: 'transient-merge',
            stage: 'target-authenticated',
            expectedUserId: operation.sourceUserId,
            sourceUserId: undefined,
            targetSession,
          });
        }
        return writeVerified({
          ...operation,
          stage: 'target-authenticated',
          targetSession,
        });
      }),

    clearAfterVerifiedSession: (operationId, verifiedUserId) =>
      locked(async () => {
        const operation = await requireOperation(operationId);
        const expected = operation.kind === 'transient-merge'
          ? operation.targetSession?.userId
          : operation.expectedUserId;
        const safeStage =
          (operation.kind === 'transient-merge' && operation.stage === 'merge-completed') ||
          ((operation.kind === 'reauth' || operation.kind === 'apple-credential-repair') &&
            operation.stage === 'target-authenticated') ||
          (operation.kind === 'main-link' &&
            (operation.stage === 'callback-claimed' || operation.stage === 'target-authenticated'));
        if (!safeStage || !expected || expected !== verifiedUserId) {
          throw new Error('Verified session UID did not match OAuth operation UID');
        }
        await removeVerified(operation);
      }),

    cancel: (operationId) =>
      locked(async () => {
        const operation = await requireOperation(operationId);
        await removeVerified(operation);
      }),
  };
}
