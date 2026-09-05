export const ACCOUNT_DELETION_RECEIPT_KEY = 'recoto.account-deletion-receipt.v1';

export type AccountDeletionStage =
  | 'created'
  | 'challenged'
  | 'processing'
  | 'db-cleared'
  | 'completed'
  | 'failed';

export interface AccountDeletionReceipt {
  version: 1;
  ownerId: string;
  requestId: string;
  receiptSecret: string;
  stage: AccountDeletionStage;
  createdAt: string;
  expiresAt?: string;
  manualRevocationRequired: boolean;
}

export interface AccountDeletionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface AccountDeletionStatus {
  requestId: string;
  status: Exclude<AccountDeletionStage, 'created'>;
  manualRevocationRequired: boolean;
  retryable: boolean;
}

export interface AccountDeletionGateway {
  start(input: {
    ownerId: string;
    requestId: string;
    receiptSecret: string;
  }): Promise<{ requestId: string; expiresAt: string }>;
  deleteAccount(input: {
    ownerId: string;
    requestId: string;
    receiptSecret: string;
    reauthenticationToken?: string;
    googleProviderToken?: string;
  }): Promise<{
    deleted: boolean;
    requestId: string;
    manualRevocationRequired: boolean;
  }>;
  status(input: {
    requestId: string;
    receiptSecret: string;
  }): Promise<AccountDeletionStatus>;
}

interface AccountDeletionCoordinatorOptions {
  storage: AccountDeletionStorage;
  gateway: AccountDeletionGateway;
  now?: () => Date;
  randomUUID?: () => string;
  randomSecret?: () => string;
}

const BASE64_URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function encodeDeletionSecret(bytes: Uint8Array): string {
  if (bytes.byteLength < 32) {
    throw new Error('Account deletion receipt entropy is too short');
  }
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += BASE64_URL_ALPHABET[(value >> 18) & 63];
    result += BASE64_URL_ALPHABET[(value >> 12) & 63];
    if (second !== undefined) result += BASE64_URL_ALPHABET[(value >> 6) & 63];
    if (third !== undefined) result += BASE64_URL_ALPHABET[value & 63];
  }
  return result;
}

function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function parseReceipt(raw: string | null): AccountDeletionReceipt | null {
  if (raw === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('The saved account deletion receipt is unreadable');
  }

  if (!value || typeof value !== 'object') {
    throw new Error('The saved account deletion receipt is invalid');
  }
  const candidate = value as Partial<AccountDeletionReceipt>;
  const stages: AccountDeletionStage[] = [
    'created',
    'challenged',
    'processing',
    'db-cleared',
    'completed',
    'failed',
  ];
  if (
    candidate.version !== 1
    || typeof candidate.ownerId !== 'string'
    || !candidate.ownerId
    || typeof candidate.requestId !== 'string'
    || !candidate.requestId
    || typeof candidate.receiptSecret !== 'string'
    || candidate.receiptSecret.length < 32
    || typeof candidate.createdAt !== 'string'
    || typeof candidate.manualRevocationRequired !== 'boolean'
    || !stages.includes(candidate.stage as AccountDeletionStage)
    || (candidate.expiresAt !== undefined && typeof candidate.expiresAt !== 'string')
  ) {
    throw new Error('The saved account deletion receipt is invalid');
  }
  return candidate as AccountDeletionReceipt;
}

function createDefaultSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return encodeDeletionSecret(bytes);
}

export function createAccountDeletionCoordinator(
  options: AccountDeletionCoordinatorOptions,
) {
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
  const randomSecret = options.randomSecret ?? createDefaultSecret;
  let operationQueue: Promise<void> = Promise.resolve();

  async function read(): Promise<AccountDeletionReceipt | null> {
    return parseReceipt(await options.storage.getItem(ACCOUNT_DELETION_RECEIPT_KEY));
  }

  async function persist(receipt: AccountDeletionReceipt): Promise<void> {
    const serialized = JSON.stringify(receipt);
    await options.storage.setItem(ACCOUNT_DELETION_RECEIPT_KEY, serialized);
    const verified = await options.storage.getItem(ACCOUNT_DELETION_RECEIPT_KEY);
    if (verified !== serialized) {
      throw new Error('The account deletion recovery receipt could not be saved');
    }
  }

  async function remove(): Promise<void> {
    await options.storage.removeItem(ACCOUNT_DELETION_RECEIPT_KEY);
    if (await options.storage.getItem(ACCOUNT_DELETION_RECEIPT_KEY) !== null) {
      throw new Error('The account deletion recovery receipt could not be cleared');
    }
  }

  function exclusively<T>(work: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(work, work);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function assertOwner(receipt: AccountDeletionReceipt, ownerId: string): void {
    if (receipt.ownerId !== ownerId) {
      throw new Error('The pending account deletion belongs to a different account');
    }
  }

  async function begin(ownerIdInput: string): Promise<AccountDeletionReceipt> {
    return exclusively(async () => {
      const ownerId = assertNonEmpty(ownerIdInput, 'A verified account owner');
      let receipt = await read();
      if (receipt) {
        assertOwner(receipt, ownerId);
        const challengeExpired = receipt.stage === 'challenged'
          && typeof receipt.expiresAt === 'string'
          && new Date(receipt.expiresAt).getTime() <= now().getTime();
        if (challengeExpired) {
          // Never discard a local receipt merely because its client-side timer
          // elapsed. The remote request may already have crossed authorization.
          const remote = await options.gateway.status({
            requestId: receipt.requestId,
            receiptSecret: receipt.receiptSecret,
          });
          if (remote.requestId !== receipt.requestId) {
            throw new Error('The deletion service returned a mismatched request ID');
          }
          if (remote.status !== 'challenged') {
            const recovered: AccountDeletionReceipt = {
              ...receipt,
              stage: remote.status,
              manualRevocationRequired: remote.manualRevocationRequired,
            };
            await persist(recovered);
            return recovered;
          }
          await remove();
          receipt = null;
        } else if (receipt.stage !== 'created') {
          return receipt;
        }
      }
      if (!receipt) {
        receipt = {
          version: 1,
          ownerId,
          requestId: assertNonEmpty(randomUUID(), 'Deletion request ID'),
          receiptSecret: assertNonEmpty(randomSecret(), 'Deletion receipt secret'),
          stage: 'created',
          createdAt: now().toISOString(),
          manualRevocationRequired: false,
        };
        if (receipt.receiptSecret.length < 32) {
          throw new Error('Deletion receipt secret must contain at least 32 characters');
        }
        // This local recovery credential must exist before the first remote write.
        await persist(receipt);
      }

      const started = await options.gateway.start({
        ownerId,
        requestId: receipt.requestId,
        receiptSecret: receipt.receiptSecret,
      });
      if (started.requestId !== receipt.requestId) {
        throw new Error('The deletion service returned a mismatched request ID');
      }

      const challenged: AccountDeletionReceipt = {
        ...receipt,
        stage: 'challenged',
        expiresAt: started.expiresAt,
      };
      await persist(challenged);
      return challenged;
    });
  }

  async function execute(input: {
    ownerId: string;
    reauthenticationToken?: string;
    googleProviderToken?: string;
  }): Promise<{
    status: 'completed';
    requestId: string;
    manualRevocationRequired: boolean;
  }> {
    return exclusively(async () => {
      const ownerId = assertNonEmpty(input.ownerId, 'A verified account owner');
      const reauthenticationToken = input.reauthenticationToken?.trim();
      const receipt = await read();
      if (!receipt) throw new Error('Start account deletion before confirming it');
      assertOwner(receipt, ownerId);

      if (receipt.stage === 'completed') {
        return {
          status: 'completed',
          requestId: receipt.requestId,
          manualRevocationRequired: receipt.manualRevocationRequired,
        };
      }
      if (receipt.stage === 'created') {
        throw new Error('The account deletion challenge has not been created yet');
      }

      const result = await options.gateway.deleteAccount({
        ownerId,
        requestId: receipt.requestId,
        receiptSecret: receipt.receiptSecret,
        ...(reauthenticationToken ? { reauthenticationToken } : {}),
        ...(input.googleProviderToken
          ? { googleProviderToken: input.googleProviderToken }
          : {}),
      });
      if (!result.deleted) throw new Error('Account deletion is still pending');
      if (result.requestId !== receipt.requestId) {
        throw new Error('The deletion service returned a mismatched request ID');
      }

      const completed: AccountDeletionReceipt = {
        ...receipt,
        stage: 'completed',
        manualRevocationRequired: result.manualRevocationRequired,
      };
      await persist(completed);
      return {
        status: 'completed',
        requestId: completed.requestId,
        manualRevocationRequired: completed.manualRevocationRequired,
      };
    });
  }

  async function recover(): Promise<AccountDeletionStatus | null> {
    return exclusively(async () => {
      const receipt = await read();
      if (!receipt) return null;

      const status = await options.gateway.status({
        requestId: receipt.requestId,
        receiptSecret: receipt.receiptSecret,
      });
      if (status.requestId !== receipt.requestId) {
        throw new Error('The deletion service returned a mismatched request ID');
      }
      const recovered: AccountDeletionReceipt = {
        ...receipt,
        stage: status.status,
        manualRevocationRequired: status.manualRevocationRequired,
      };
      await persist(recovered);
      return status;
    });
  }

  async function acknowledgeCompleted(requestIdInput: string): Promise<void> {
    return exclusively(async () => {
      const requestId = assertNonEmpty(requestIdInput, 'Deletion request ID');
      const receipt = await read();
      if (!receipt) return;
      if (receipt.requestId !== requestId) {
        throw new Error('The deletion receipt belongs to a different request');
      }
      if (receipt.stage !== 'completed') {
        throw new Error('Account deletion has not completed yet');
      }
      await remove();
    });
  }

  return {
    begin,
    read,
    execute,
    recover,
    acknowledgeCompleted,
  };
}
