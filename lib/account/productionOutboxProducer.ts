import type { CloudEntity, OutboxMutation, PersonalSnapshot } from '../../types/account';
import type { AccountBootstrapPersistence } from './accountBootstrap';
import {
  ACCOUNT_OUTBOX_CONFLICT_BACKUP_DOMAIN,
  ACCOUNT_OUTBOX_DOMAIN,
  ACCOUNT_SYNC_STATE_DOMAIN,
  type AccountRuntimeSyncPersistence,
} from './accountBootstrapPersistence';
import type { CloudRow } from './cloudRepository';
import type { KeyValueStorage, OwnerStorage } from './namespacedStorage';
import type {
  AccountOutboxProducerPersistence,
  AccountOutboxProducerSyncState,
} from './outboxProducer';
import type { OutboxConflictBackup } from './syncEngine';

const cloudEntities = new Set<CloudEntity>([
  'calendar-entry',
  'special-date',
  'preference',
  'stamp',
  'trip',
  'trip-item',
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ownerKey(ownerId: string, domain: string) {
  if (!ownerId || ownerId.includes(':')) throw new Error('Invalid account owner');
  return `recoto:user:${ownerId}:${domain}`;
}

async function requireSelectedOwner(ownerStorage: OwnerStorage, ownerId: string) {
  const owner = await ownerStorage.getOwner();
  if (owner.kind !== 'user' || owner.id !== ownerId) {
    throw new Error(`The active owner does not match ${ownerId}`);
  }
}

function parseCloudRows(value: unknown, ownerId: string): CloudRow[] {
  if (!Array.isArray(value)) throw new Error('Invalid producer cloud rows');
  return value.map((candidate) => {
    if (
      !isRecord(candidate)
      || candidate.ownerId !== ownerId
      || !cloudEntities.has(candidate.entity as CloudEntity)
      || typeof candidate.id !== 'string'
      || !candidate.id
      || !Number.isSafeInteger(candidate.revision)
      || Number(candidate.revision) < 1
      || (candidate.payload !== null && !isRecord(candidate.payload))
      || typeof candidate.updatedAt !== 'string'
      || (candidate.deletedAt !== undefined && typeof candidate.deletedAt !== 'string')
    ) {
      throw new Error('Invalid producer cloud row');
    }
    if (candidate.deletedAt && candidate.payload !== null) {
      throw new Error('Invalid producer tombstone');
    }
    return clone(candidate) as unknown as CloudRow;
  });
}

function parseSyncState(value: unknown, ownerId: string): AccountOutboxProducerSyncState | null {
  if (value === null) return null;
  if (
    !isRecord(value)
    || value.version !== 1
    || value.ownerId !== ownerId
    || value.migrationComplete !== true
    || typeof value.cursor !== 'string'
    || typeof value.lastSyncedAt !== 'string'
  ) {
    throw new Error('Invalid producer sync state');
  }
  return {
    rows: parseCloudRows(value.rows, ownerId),
    cursor: value.cursor,
    lastSyncedAt: value.lastSyncedAt,
  };
}

function parseMutation(value: unknown, ownerId: string): OutboxMutation {
  if (
    !isRecord(value)
    || value.ownerId !== ownerId
    || typeof value.mutationId !== 'string'
    || !UUID_PATTERN.test(value.mutationId)
    || !cloudEntities.has(value.entity as CloudEntity)
    || typeof value.entityId !== 'string'
    || !value.entityId
    || (value.operation !== 'upsert' && value.operation !== 'delete')
    || (value.payload !== null && !isRecord(value.payload))
    || (
      value.baseRevision !== null
      && (!Number.isSafeInteger(value.baseRevision) || Number(value.baseRevision) < 1)
    )
    || typeof value.createdAt !== 'string'
    || !Number.isSafeInteger(value.attempts)
    || Number(value.attempts) < 0
  ) throw new Error('Invalid producer outbox mutation');
  if (
    (value.operation === 'delete' && value.payload !== null)
    || (value.operation === 'upsert' && value.payload === null)
  ) throw new Error('Invalid producer outbox payload');
  return clone(value) as unknown as OutboxMutation;
}

function parseOutbox(value: unknown, ownerId: string): OutboxMutation[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error('Invalid producer outbox');
  return value.map((item) => parseMutation(item, ownerId));
}

function parseJson(raw: string | null, label: string): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function parseConflictBackups(value: unknown, ownerId: string): OutboxConflictBackup[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error('Invalid producer conflict backups');
  return value.map((item) => {
    if (!isRecord(item) || !isRecord(item.mutation)) {
      throw new Error('Invalid producer conflict backup');
    }
    parseMutation(item.mutation, ownerId);
    return clone(item) as unknown as OutboxConflictBackup;
  });
}

export function createAccountOutboxProducerPersistence({
  storage,
  ownerStorage,
  bootstrapPersistence,
}: {
  storage: KeyValueStorage;
  ownerStorage: OwnerStorage;
  bootstrapPersistence: AccountBootstrapPersistence & AccountRuntimeSyncPersistence;
}): AccountOutboxProducerPersistence {
  const readDomain = async (ownerId: string, domain: string) => {
    await requireSelectedOwner(ownerStorage, ownerId);
    const raw = await storage.getItem(ownerKey(ownerId, domain));
    await requireSelectedOwner(ownerStorage, ownerId);
    return raw;
  };

  return {
    async readSyncState(ownerId) {
      return parseSyncState(
        parseJson(await readDomain(ownerId, ACCOUNT_SYNC_STATE_DOMAIN), 'producer sync state'),
        ownerId,
      );
    },

    async readOutbox(ownerId) {
      return parseOutbox(
        parseJson(await readDomain(ownerId, ACCOUNT_OUTBOX_DOMAIN), 'producer outbox'),
        ownerId,
      );
    },

    async commitOutbox(ownerId, mutations) {
      await requireSelectedOwner(ownerStorage, ownerId);
      const parsed = mutations.map((mutation) => parseMutation(mutation, ownerId));
      const serialized = JSON.stringify(parsed);
      await storage.setItem(ownerKey(ownerId, ACCOUNT_OUTBOX_DOMAIN), serialized);
      await requireSelectedOwner(ownerStorage, ownerId);
      const verified = parseOutbox(
        parseJson(
          await storage.getItem(ownerKey(ownerId, ACCOUNT_OUTBOX_DOMAIN)),
          'persisted producer outbox',
        ),
        ownerId,
      );
      if (JSON.stringify(verified) !== serialized) {
        throw new Error('The producer outbox could not be verified after persistence');
      }
    },

    async persistConflictBackups(ownerId, conflicts) {
      await requireSelectedOwner(ownerStorage, ownerId);
      const key = ownerKey(ownerId, ACCOUNT_OUTBOX_CONFLICT_BACKUP_DOMAIN);
      const existing = parseConflictBackups(
        parseJson(await storage.getItem(key), 'producer conflict backups'),
        ownerId,
      );
      const additions = conflicts.map((conflict) => {
        parseMutation(conflict.mutation, ownerId);
        return clone(conflict);
      });
      await storage.setItem(key, JSON.stringify([...existing, ...additions]));
      await requireSelectedOwner(ownerStorage, ownerId);
    },

    async commitRemoteState(ownerId, state, snapshot: PersonalSnapshot, guard) {
      await requireSelectedOwner(ownerStorage, ownerId);
      if (state.rows.some((row) => row.ownerId !== ownerId)) {
        throw new Error('Producer remote state owner mismatch');
      }
      const committed = await bootstrapPersistence.commitRuntimeSync(ownerId, {
        rows: state.rows.map(clone),
        cursor: state.cursor,
        conflictBackups: [],
        migrationComplete: true,
        syncPhase: 'synced',
      }, snapshot, guard);
      await requireSelectedOwner(ownerStorage, ownerId);
      return committed;
    },
  };
}
