import {
  CURRENT_PERSONAL_SCHEMA_VERSION,
  type CloudEntity,
  type OutboxMutation,
  type PersonalSnapshot,
} from '../../types/account';
import type {
  CloudRepository,
  CloudRow,
  CloudRowSeed,
} from './cloudRepository';
import { requireCurrentPersonalSchemaVersion } from './cloudRepository';
import type { OwnerStorage } from './namespacedStorage';
import { snapshotFromCloudRows, snapshotToCloudRows } from './accountBootstrapPersistence';
import {
  flushOutbox,
  type OutboxConflictBackup,
} from './syncEngine';

export const ACCOUNT_OUTBOX_MANAGED_ENTITIES = [
  'calendar-entry',
  'special-date',
  'preference',
  'stamp',
] as const satisfies readonly CloudEntity[];

export const ACCOUNT_OUTBOX_TRIP_ENTITIES = [
  'trip',
  'trip-item',
] as const satisfies readonly CloudEntity[];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AccountOutboxProducerSyncState {
  rows: CloudRow[];
  cursor: string;
  lastSyncedAt: string;
}

export interface AccountOutboxProducerPersistence {
  readSyncState(ownerId: string): Promise<AccountOutboxProducerSyncState | null>;
  readOutbox(ownerId: string): Promise<OutboxMutation[]>;
  commitOutbox(ownerId: string, mutations: readonly OutboxMutation[]): Promise<void>;
  persistConflictBackups(
    ownerId: string,
    conflicts: readonly OutboxConflictBackup[],
  ): Promise<void>;
  commitRemoteState(
    ownerId: string,
    state: AccountOutboxProducerSyncState,
    snapshot: PersonalSnapshot,
    guard: AccountRemotePublishGuard,
  ): Promise<boolean>;
}

export interface AccountRemotePublishGuard {
  /** False after hook cleanup or an owner-generation change. */
  isCurrent(): boolean;
  /** Rechecked after every awaited durable write. */
  canPublish(): boolean;
  /** Keeps synchronous store notifications from being mistaken for user edits. */
  runWhilePublishing<T>(publish: () => T): T;
}

interface DiffOptions {
  ownerId: string;
  baselineRows: readonly CloudRow[];
  pending: readonly OutboxMutation[];
  localRows: readonly CloudRowSeed[];
  now: string;
  randomUUID: () => string;
  managedEntities?: readonly CloudEntity[];
  heldRows?: readonly PendingPersonalMediaReference[];
}

/**
 * A row containing a device-only URI must wait for PersonalMediaService to
 * replace every source URI with an owner-scoped Storage object key.
 */
export interface PendingPersonalMediaReference {
  entity: Extract<CloudEntity, 'calendar-entry' | 'stamp' | 'trip'>;
  entityId: string;
  domain: 'calendar' | 'diary' | 'stamp' | 'trip';
  sourceUris: string[];
}

function isPendingDeviceMediaUri(value: unknown): value is string {
  return typeof value === 'string'
    && /^(?:(?:file|content|blob):|data:image\/)/i.test(value);
}

/** Discovery API consumed by the future upload worker before ordinary row sync. */
export function findPendingPersonalMediaReferences(
  snapshot: PersonalSnapshot,
): PendingPersonalMediaReference[] {
  const pending: PendingPersonalMediaReference[] = [];
  for (const [entityId, entry] of Object.entries(snapshot.entries)) {
    if (isPendingDeviceMediaUri(entry.imageUri)) {
      pending.push({
        entity: 'calendar-entry',
        entityId,
        domain: 'calendar',
        sourceUris: [entry.imageUri],
      });
    }
    const diaryUris = (entry.diaryPhotos ?? []).filter(isPendingDeviceMediaUri);
    if (diaryUris.length > 0) {
      pending.push({
        entity: 'calendar-entry',
        entityId,
        domain: 'diary',
        sourceUris: [...diaryUris],
      });
    }
  }
  for (const stamp of snapshot.stamps) {
    if (!isPendingDeviceMediaUri(stamp.imageUri)) continue;
    pending.push({
      entity: 'stamp',
      entityId: stamp.id,
      domain: 'stamp',
      sourceUris: [stamp.imageUri],
    });
  }
  return pending;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rowKey(entity: CloudEntity, id: string) {
  return `${entity}\u0000${id}`;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined).sort();
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && jsonEqual(leftRecord[key], rightRecord[key])
    ));
}

function assertOwner(ownerId: string, candidate: { ownerId?: string }, label: string) {
  if (candidate.ownerId !== undefined && candidate.ownerId !== ownerId) {
    throw new Error(`${label} belongs to another owner`);
  }
}

function desiredStateEqual(
  operation: 'upsert' | 'delete',
  payload: Record<string, unknown> | null,
  localPayload: Record<string, unknown> | null,
) {
  if (localPayload === null) return operation === 'delete';
  return operation === 'upsert' && jsonEqual(payload, localPayload);
}

function managedSeedState(rows: readonly CloudRowSeed[], managedEntities: ReadonlySet<CloudEntity>) {
  const result = new Map<string, Record<string, unknown> | null>();
  for (const seed of rows) {
    const entity = seed.entity ?? 'calendar-entry';
    if (!managedEntities.has(entity)) continue;
    result.set(rowKey(entity, seed.id), clone(seed.payload));
  }
  return result;
}

function changedManagedRowKeys(
  before: readonly CloudRowSeed[],
  after: readonly CloudRowSeed[],
  managedEntities: ReadonlySet<CloudEntity>,
): Set<string> {
  const beforeByKey = managedSeedState(before, managedEntities);
  const afterByKey = managedSeedState(after, managedEntities);
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  return new Set([...keys].filter((key) => (
    !beforeByKey.has(key)
    || !afterByKey.has(key)
    || !jsonEqual(beforeByKey.get(key), afterByKey.get(key))
  )));
}

/**
 * Produces only mutations not already represented by the durable outbox.
 * Callers opt into additional owner-scoped domains only after their stores ship.
 */
export function diffSnapshotRowsToOutbox(options: DiffOptions): OutboxMutation[] {
  const managedEntities = new Set<CloudEntity>(
    options.managedEntities ?? ACCOUNT_OUTBOX_MANAGED_ENTITIES,
  );
  const heldRowKeys = new Set(
    (options.heldRows ?? []).map((hold) => rowKey(hold.entity, hold.entityId)),
  );
  const baselineByKey = new Map<string, CloudRow>();
  for (const row of options.baselineRows) {
    assertOwner(options.ownerId, row, 'Baseline row');
    requireCurrentPersonalSchemaVersion(row.schemaVersion, `Baseline row ${row.entity}:${row.id}`);
    if (managedEntities.has(row.entity)) baselineByKey.set(rowKey(row.entity, row.id), row);
  }

  const projectedByKey = new Map<string, {
    entity: CloudEntity;
    id: string;
    operation: 'upsert' | 'delete';
    payload: Record<string, unknown> | null;
  }>();
  for (const row of baselineByKey.values()) {
    projectedByKey.set(rowKey(row.entity, row.id), {
      entity: row.entity,
      id: row.id,
      operation: row.deletedAt || row.payload === null ? 'delete' : 'upsert',
      payload: clone(row.payload),
    });
  }
  for (const mutation of options.pending) {
    assertOwner(options.ownerId, mutation, 'Outbox mutation');
    requireCurrentPersonalSchemaVersion(
      mutation.schemaVersion,
      `Outbox mutation ${mutation.mutationId}`,
    );
    if (!managedEntities.has(mutation.entity)) continue;
    projectedByKey.set(rowKey(mutation.entity, mutation.entityId), {
      entity: mutation.entity,
      id: mutation.entityId,
      operation: mutation.operation,
      payload: clone(mutation.payload),
    });
  }

  const localByKey = new Map<string, {
    entity: CloudEntity;
    id: string;
    payload: Record<string, unknown>;
  }>();
  for (const seed of options.localRows) {
    assertOwner(options.ownerId, seed, 'Local row');
    const entity = seed.entity ?? 'calendar-entry';
    requireCurrentPersonalSchemaVersion(seed.schemaVersion, `Local row ${entity}:${seed.id}`);
    if (!managedEntities.has(entity)) continue;
    if (seed.payload === null) continue;
    localByKey.set(rowKey(entity, seed.id), {
      entity,
      id: seed.id,
      payload: clone(seed.payload),
    });
  }

  const mutations: OutboxMutation[] = [];
  const createMutation = (
    entity: CloudEntity,
    entityId: string,
    operation: 'upsert' | 'delete',
    payload: Record<string, unknown> | null,
  ) => {
    const mutationId = options.randomUUID();
    if (!UUID_PATTERN.test(mutationId)) throw new Error('Invalid mutation UUID');
    mutations.push({
      mutationId,
      ownerId: options.ownerId,
      entity,
      entityId,
      operation,
      payload: clone(payload),
      baseRevision: baselineByKey.get(rowKey(entity, entityId))?.revision ?? null,
      createdAt: options.now,
      attempts: 0,
      schemaVersion: CURRENT_PERSONAL_SCHEMA_VERSION,
    });
  };

  for (const local of localByKey.values()) {
    const key = rowKey(local.entity, local.id);
    if (heldRowKeys.has(key)) continue;
    const projected = projectedByKey.get(key);
    if (!projected || !desiredStateEqual(projected.operation, projected.payload, local.payload)) {
      createMutation(local.entity, local.id, 'upsert', local.payload);
    }
  }

  const missingProjectedRows = [...projectedByKey.entries()].filter(([key, projected]) => (
    !heldRowKeys.has(key)
    && !localByKey.has(key)
    && !desiredStateEqual(projected.operation, projected.payload, null)
  ));
  missingProjectedRows.sort(([, left], [, right]) => {
    const deleteRank = (entity: CloudEntity) => {
      if (entity === 'trip-item') return 0;
      if (entity === 'trip') return 2;
      return 1;
    };
    return deleteRank(left.entity) - deleteRank(right.entity);
  });
  for (const [, projected] of missingProjectedRows) {
    createMutation(projected.entity, projected.id, 'delete', null);
  }

  return mutations;
}

class SupersededProducer extends Error {}

export type AccountOutboxProducerResult =
  | {
      status: 'completed';
      syncPhase: 'synced' | 'pending' | 'reauth-required' | 'error';
      enqueued: number;
      syncedAt: string | null;
      /** True when a newer edit arrived during the just-finished synchronization. */
      followUpRequired: boolean;
      mediaPending: boolean;
      /** Durable backoff selected by the sync engine after a retryable failure. */
      retryDelayMs?: number | null;
    }
  | { status: 'superseded' };

interface AccountOutboxProducerOptions {
  ownerId: string;
  ownerStorage: OwnerStorage;
  persistence: AccountOutboxProducerPersistence;
  repository: CloudRepository;
  readSnapshot(): PersonalSnapshot;
  readPendingMedia?: () => readonly PendingPersonalMediaReference[];
  now?: () => Date;
  randomUUID: () => string;
  managedEntities?: readonly CloudEntity[];
  onSyncing?: () => void;
  onResult?: (result: AccountOutboxProducerResult) => void;
}

async function requireSelectedOwner(ownerStorage: OwnerStorage, ownerId: string) {
  const owner = await ownerStorage.getOwner();
  if (owner.kind !== 'user' || owner.id !== ownerId) throw new SupersededProducer();
}

export function createAccountOutboxProducer(options: AccountOutboxProducerOptions) {
  const now = options.now ?? (() => new Date());
  const producerManagedEntities = new Set<CloudEntity>(
    options.managedEntities ?? ACCOUNT_OUTBOX_MANAGED_ENTITIES,
  );
  let generation = 0;
  let localGeneration = 0;
  let applyingRemote = false;
  let queue: Promise<void> = Promise.resolve();

  const run = async (startedAtGeneration: number): Promise<AccountOutboxProducerResult> => {
    const checkCurrent = async () => {
      if (startedAtGeneration !== generation) throw new SupersededProducer();
      await requireSelectedOwner(options.ownerStorage, options.ownerId);
      if (startedAtGeneration !== generation) throw new SupersededProducer();
    };

    const guardRepositoryCall = async <T>(call: () => Promise<T>) => {
      await checkCurrent();
      const result = await call();
      await checkCurrent();
      return result;
    };

    const repository: CloudRepository = {
      pull: (ownerId, cursor) => guardRepositoryCall(() => options.repository.pull(ownerId, cursor)),
      getMutationReceipts: (ownerId, ids) => guardRepositoryCall(
        () => options.repository.getMutationReceipts(ownerId, ids),
      ),
      applyMutation: (mutation) => guardRepositoryCall(
        () => options.repository.applyMutation(mutation),
      ),
      verify: (ownerId, expectations) => guardRepositoryCall(
        () => options.repository.verify(ownerId, expectations),
      ),
    };

    try {
      await checkCurrent();
      const syncState = await options.persistence.readSyncState(options.ownerId);
      await checkCurrent();
      if (!syncState) {
        const result: AccountOutboxProducerResult = {
          status: 'completed',
          syncPhase: 'error',
          enqueued: 0,
          syncedAt: null,
          followUpRequired: false,
          mediaPending: false,
        };
        options.onResult?.(result);
        return result;
      }

      const pending = await options.persistence.readOutbox(options.ownerId);
      await checkCurrent();
      const mediaHolds = options.readPendingMedia?.().map(clone) ?? [];
      const heldRowKeys = new Set(
        mediaHolds.map((hold) => rowKey(hold.entity, hold.entityId)),
      );
      const capturedAt = now().toISOString();
      const localRows = snapshotToCloudRows(
        { kind: 'user', id: options.ownerId },
        options.readSnapshot(),
        syncState.rows,
        capturedAt,
      );
      const additions = diffSnapshotRowsToOutbox({
        ownerId: options.ownerId,
        baselineRows: syncState.rows,
        pending,
        localRows,
        now: capturedAt,
        randomUUID: options.randomUUID,
        managedEntities: [...producerManagedEntities],
        heldRows: mediaHolds,
      });
      const durable = [...pending.map(clone), ...additions.map(clone)];
      if (additions.length > 0) {
        // The owner check is adjacent to the durable write: no network request can
        // happen until every newly discovered edit is recoverable after process death.
        await checkCurrent();
        await options.persistence.commitOutbox(options.ownerId, durable);
        await checkCurrent();
      }

      if (mediaHolds.length > 0) {
        // Without a completed media upload we cannot atomically advance the
        // shared remote baseline. Keep every ordinary edit durable and defer
        // all networking so a later run cannot recreate already-applied rows.
        const result: AccountOutboxProducerResult = {
          status: 'completed',
          syncPhase: 'pending',
          enqueued: additions.length,
          syncedAt: null,
          followUpRequired: false,
          mediaPending: true,
        };
        options.onResult?.(result);
        return result;
      }

      options.onSyncing?.();
      await checkCurrent();
      const activeDurable = durable.filter((mutation) => (
        !heldRowKeys.has(rowKey(mutation.entity, mutation.entityId))
      ));
      const deferredDurable = durable.filter((mutation) => (
        heldRowKeys.has(rowKey(mutation.entity, mutation.entityId))
      ));
      const mergeDeferred = (next: readonly OutboxMutation[]) => {
        const nextById = new Map(next.map((mutation) => [mutation.mutationId, mutation]));
        const retained = durable.flatMap((mutation) => {
          if (heldRowKeys.has(rowKey(mutation.entity, mutation.entityId))) return [clone(mutation)];
          const replacement = nextById.get(mutation.mutationId);
          return replacement ? [clone(replacement)] : [];
        });
        const retainedIds = new Set(retained.map((mutation) => mutation.mutationId));
        return [
          ...retained,
          ...next.filter((mutation) => !retainedIds.has(mutation.mutationId)).map(clone),
        ];
      };
      const flush = await flushOutbox(activeDurable, repository, {
        ownerId: options.ownerId,
        lastSyncedAt: syncState.lastSyncedAt,
        now: now(),
        commitOutbox: async (next) => {
          await checkCurrent();
          await options.persistence.commitOutbox(options.ownerId, mergeDeferred(next));
          await checkCurrent();
        },
        persistConflictBackups: async (conflicts) => {
          await checkCurrent();
          await options.persistence.persistConflictBackups(options.ownerId, conflicts);
          await checkCurrent();
        },
      });

      if (flush.syncPhase !== 'synced') {
        const result: AccountOutboxProducerResult = {
          status: 'completed',
          syncPhase: flush.syncPhase,
          enqueued: additions.length,
          syncedAt: null,
          followUpRequired: false,
          mediaPending: deferredDurable.length > 0 || mediaHolds.length > 0,
          retryDelayMs: flush.retryDelayMs,
        };
        options.onResult?.(result);
        return result;
      }

      const remote = await repository.pull(options.ownerId);
      const syncedAt = now().toISOString();
      await checkCurrent();
      const localGenerationAtSnapshot = localGeneration;
      const latestSnapshot = options.readSnapshot();
      const latestLocalRows = snapshotToCloudRows(
        { kind: 'user', id: options.ownerId },
        latestSnapshot,
        remote.rows,
        syncedAt,
      );
      const latestMediaHolds = options.readPendingMedia?.().map(clone) ?? [];
      if (latestMediaHolds.length > 0) {
        const result: AccountOutboxProducerResult = {
          status: 'completed',
          syncPhase: 'pending',
          enqueued: additions.length,
          syncedAt: null,
          followUpRequired: false,
          mediaPending: true,
        };
        options.onResult?.(result);
        return result;
      }
      const locallyChangedDuringSync = changedManagedRowKeys(
        localRows,
        latestLocalRows,
        producerManagedEntities,
      );
      const carryMutations = locallyChangedDuringSync.size === 0
        ? []
        : diffSnapshotRowsToOutbox({
            ownerId: options.ownerId,
            baselineRows: remote.rows.filter((row) => (
              locallyChangedDuringSync.has(rowKey(row.entity, row.id))
            )),
            pending: [],
            localRows: latestLocalRows.filter((row) => {
              const entity = row.entity ?? 'calendar-entry';
              return locallyChangedDuringSync.has(rowKey(entity, row.id));
            }),
            now: syncedAt,
            randomUUID: options.randomUUID,
            managedEntities: [...producerManagedEntities],
            heldRows: latestMediaHolds,
          });
      if (carryMutations.length > 0) {
        // A user may edit while the remote request is in flight. Preserve that
        // newer intent before publishing the pulled snapshot locally.
        await checkCurrent();
        await options.persistence.commitOutbox(options.ownerId, carryMutations);
        await checkCurrent();
      }

      const rowsForVisibleSnapshot = [
        ...remote.rows.filter((row) => (
          !locallyChangedDuringSync.has(rowKey(row.entity, row.id))
        )),
        ...latestLocalRows.filter((row) => {
          const entity = row.entity ?? 'calendar-entry';
          return locallyChangedDuringSync.has(rowKey(entity, row.id));
        }).map((row): CloudRow => ({
          ownerId: options.ownerId,
          entity: row.entity ?? 'calendar-entry',
          id: row.id,
          revision: row.revision,
          payload: clone(row.payload),
          updatedAt: row.updatedAt ?? syncedAt,
          schemaVersion: requireCurrentPersonalSchemaVersion(
            row.schemaVersion,
            `Local row ${row.entity ?? 'calendar-entry'}:${row.id}`,
          ),
        })),
      ];
      const committed = await options.persistence.commitRemoteState(
        options.ownerId,
        { rows: remote.rows.map(clone), cursor: remote.cursor, lastSyncedAt: syncedAt },
        snapshotFromCloudRows(rowsForVisibleSnapshot),
        {
          isCurrent: () => startedAtGeneration === generation,
          canPublish: () => (
            startedAtGeneration === generation
            && localGenerationAtSnapshot === localGeneration
          ),
          runWhilePublishing: <T,>(publish: () => T) => {
            applyingRemote = true;
            try {
              return publish();
            } finally {
              applyingRemote = false;
            }
          },
        },
      );
      await checkCurrent();
      if (!committed) {
        const result: AccountOutboxProducerResult = {
          status: 'completed',
          syncPhase: 'pending',
          enqueued: additions.length + carryMutations.length,
          syncedAt: null,
          followUpRequired: true,
          mediaPending: false,
        };
        options.onResult?.(result);
        return result;
      }
      const result: AccountOutboxProducerResult = {
        status: 'completed',
        syncPhase: carryMutations.length > 0 ? 'pending' : 'synced',
        enqueued: additions.length + carryMutations.length,
        syncedAt: carryMutations.length > 0 ? null : syncedAt,
        followUpRequired: carryMutations.length > 0,
        mediaPending: false,
      };
      options.onResult?.(result);
      return result;
    } catch (error) {
      if (error instanceof SupersededProducer || startedAtGeneration !== generation) {
        return { status: 'superseded' };
      }
      throw error;
    }
  };

  return {
    reconcileAndFlush() {
      const startedAtGeneration = generation;
      const result = queue.then(() => run(startedAtGeneration));
      queue = result.then(() => undefined, () => undefined);
      return result;
    },

    isApplyingRemote: () => applyingRemote,

    noteLocalChange() {
      localGeneration += 1;
    },

    invalidate() {
      generation += 1;
    },

    async whenIdle() {
      await queue;
    },
  };
}
