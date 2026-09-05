import type { OutboxMutation, SyncPhase } from '../../types/account';
import {
  CloudRepositoryError,
  type CloudRepository,
  type CloudRow,
  type CloudRowSeed,
  type CloudVerificationExpectation,
  type MutationAcknowledgement,
  type MutationAcknowledgementStatus,
} from './cloudRepository';

export { CloudRepositoryError, createMemoryCloudRepository } from './cloudRepository';
export type {
  CloudRepository,
  CloudRow,
  CloudRowSeed,
  CloudPullResult,
  CloudVerificationExpectation,
  CloudVerificationFailure,
  CloudVerificationResult,
  MutationAcknowledgement,
  MutationAcknowledgementStatus,
} from './cloudRepository';

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 60_000, 300_000] as const;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1_000;

export interface InitialMigrationOptions {
  ownerId: string;
  localRows: readonly CloudRowSeed[];
  repository: CloudRepository;
  waitForHydration: () => Promise<void>;
  persistLocalBackup: (rows: readonly CloudRow[]) => Promise<void>;
  markMigrationComplete: (completion: MigrationCompletion) => Promise<void>;
}

export interface MigrationCompletion {
  rows: CloudRow[];
  conflictBackups: CloudRow[];
  cursor: string;
  migrationComplete: true;
  syncPhase: Extract<SyncPhase, 'synced' | 'conflict-backed-up'>;
}

export interface InitialMigrationResult extends MigrationCompletion {
  localSnapshotBackup: CloudRow[];
}

export interface MutationKey {
  ownerId: string;
  mutationId: string;
}

export interface AcknowledgedMutation extends MutationKey {
  status: MutationAcknowledgementStatus;
}

export interface OutboxConflictBackup {
  mutation: OutboxMutation;
  remoteRow: CloudRow | null;
  reason:
    | 'remote-exists'
    | 'remote-newer'
    | 'remote-deleted'
    | 'remote-missing'
    | 'server-conflict'
    | 'prior-mutation-conflict';
}

export interface FlushOutboxOptions {
  /** Restricts a flush to the owner currently active in the UI. */
  ownerId?: string;
  lastSyncedAt?: string | Date | null;
  now?: Date;
  commitOutbox: (pending: readonly OutboxMutation[]) => Promise<void>;
  persistConflictBackups: (conflicts: readonly OutboxConflictBackup[]) => Promise<void>;
}

export interface FlushOutboxResult {
  pending: OutboxMutation[];
  acknowledgedMutations: AcknowledgedMutation[];
  discardedMutations: MutationKey[];
  conflictBackups: OutboxConflictBackup[];
  syncPhase: Extract<SyncPhase, 'synced' | 'pending' | 'reauth-required' | 'error'>;
  retryDelayMs: number | null;
}

function entityRowKey(entity: string, entityId: string): string {
  return `${entity}\u0000${entityId}`;
}

function cloudRowKey(row: Pick<CloudRow, 'entity' | 'id'>): string {
  return entityRowKey(row.entity, row.id);
}

function mutationRowKey(
  mutation: Pick<OutboxMutation, 'ownerId' | 'entity' | 'entityId'>,
): string {
  return `${mutation.ownerId}\u0000${entityRowKey(mutation.entity, mutation.entityId)}`;
}

function outboxMutationKey(
  mutation: Pick<OutboxMutation, 'ownerId' | 'mutationId'>,
): string {
  return `${mutation.ownerId}\u0000${mutation.mutationId}`;
}

function clonePayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  return payload === null ? null : JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function cloneRow(row: CloudRow): CloudRow {
  return { ...row, payload: clonePayload(row.payload) };
}

function cloneMutation(mutation: OutboxMutation): OutboxMutation {
  return { ...mutation, payload: clonePayload(mutation.payload) };
}

function normalizeRow(seed: CloudRowSeed, ownerId: string): CloudRow {
  if (seed.ownerId !== undefined && seed.ownerId !== ownerId) {
    throw new CloudRepositoryError(
      'owner-scope-violation',
      `Local row ${seed.id} does not belong to ${ownerId}.`,
      false,
    );
  }
  return {
    ownerId,
    entity: seed.entity ?? 'calendar-entry',
    id: seed.id,
    revision: seed.revision,
    payload: clonePayload(seed.payload),
    updatedAt: seed.updatedAt ?? seed.deletedAt ?? '1970-01-01T00:00:00.000Z',
    ...(seed.deletedAt ? { deletedAt: seed.deletedAt } : {}),
  };
}

function assertRowsBelongToOwner(rows: readonly CloudRow[], ownerId: string): void {
  const foreign = rows.find((row) => row.ownerId !== ownerId);
  if (foreign) {
    throw new CloudRepositoryError(
      'owner-scope-violation',
      `Cloud row ${foreign.id} does not belong to ${ownerId}.`,
      false,
    );
  }
}

function jsonValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a)
      && Array.isArray(b)
      && a.length === b.length
      && a.every((value, index) => jsonValuesEqual(value, b[index]));
  }

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).filter((key) => aRecord[key] !== undefined).sort();
  const bKeys = Object.keys(bRecord).filter((key) => bRecord[key] !== undefined).sort();
  return aKeys.length === bKeys.length
    && aKeys.every((key, index) => (
      key === bKeys[index] && jsonValuesEqual(aRecord[key], bRecord[key])
    ));
}

function assertDuplicateMutationIntegrity(mutations: readonly OutboxMutation[]): void {
  const immutableByKey = new Map<string, Omit<OutboxMutation, 'attempts'>>();
  for (const mutation of mutations) {
    const key = outboxMutationKey(mutation);
    const { attempts: _attempts, ...immutable } = mutation;
    const previous = immutableByKey.get(key);
    if (previous && !jsonValuesEqual(previous, immutable)) {
      throw new CloudRepositoryError(
        'outbox-corruption',
        `Mutation ${mutation.mutationId} has conflicting immutable fields.`,
        false,
      );
    }
    if (!previous) immutableByKey.set(key, immutable);
  }
}

function rowsDiffer(a: CloudRow, b: CloudRow): boolean {
  return a.deletedAt !== b.deletedAt
    || a.revision !== b.revision
    || !jsonValuesEqual(a.payload, b.payload);
}

function migrationMutation(ownerId: string, row: CloudRow): OutboxMutation {
  return {
    mutationId: `initial:${ownerId}:${row.entity}:${row.id}:${row.revision}`,
    ownerId,
    entity: row.entity,
    entityId: row.id,
    operation: row.deletedAt || row.payload === null ? 'delete' : 'upsert',
    payload: clonePayload(row.payload),
    baseRevision: null,
    createdAt: row.updatedAt,
    attempts: 0,
  };
}

function samePayload(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null,
): boolean {
  return jsonValuesEqual(a, b);
}

function rowsAreTheSameVersion(a: CloudRow, b: CloudRow): boolean {
  return a.ownerId === b.ownerId
    && a.entity === b.entity
    && a.id === b.id
    && a.revision === b.revision
    && a.updatedAt === b.updatedAt
    && a.deletedAt === b.deletedAt
    && samePayload(a.payload, b.payload);
}

function acknowledgementError(message: string): CloudRepositoryError {
  return new CloudRepositoryError('ack-mismatch', message, true);
}

function assertAcknowledgement(
  mutation: OutboxMutation,
  acknowledgement: MutationAcknowledgement,
): void {
  if (acknowledgement.ownerId !== mutation.ownerId) {
    throw new CloudRepositoryError(
      'owner-scope-violation',
      `Acknowledgement ${mutation.mutationId} belongs to another owner.`,
      false,
    );
  }
  if (
    acknowledgement.mutationId !== mutation.mutationId
    || acknowledgement.entity !== mutation.entity
    || acknowledgement.entityId !== mutation.entityId
  ) {
    throw acknowledgementError(`Cloud acknowledgement did not match ${mutation.mutationId}.`);
  }
  if (!(['applied', 'conflict'] as const).includes(acknowledgement.status)) {
    throw acknowledgementError(`Cloud acknowledgement ${mutation.mutationId} has an invalid status.`);
  }

  const row = acknowledgement.row;
  if (!row) {
    if (
      acknowledgement.status !== 'conflict'
      || acknowledgement.revision !== null
      || acknowledgement.deleted
      || mutation.baseRevision === null
    ) {
      throw acknowledgementError(`Cloud acknowledgement ${mutation.mutationId} has no valid row.`);
    }
    return;
  }

  if (row.ownerId !== mutation.ownerId) {
    throw new CloudRepositoryError(
      'owner-scope-violation',
      `Acknowledgement row ${row.id} belongs to another owner.`,
      false,
    );
  }
  if (row.entity !== mutation.entity || row.id !== mutation.entityId) {
    throw acknowledgementError(`Cloud acknowledgement ${mutation.mutationId} points at another row.`);
  }
  if (
    !Number.isSafeInteger(acknowledgement.revision)
    || acknowledgement.revision === null
    || acknowledgement.revision < 1
    || acknowledgement.revision !== row.revision
  ) {
    throw acknowledgementError(`Cloud acknowledgement ${mutation.mutationId} has an invalid revision.`);
  }

  const rowIsDeleted = Boolean(row.deletedAt);
  if (
    acknowledgement.deleted !== rowIsDeleted
    || (row.payload === null) !== rowIsDeleted
  ) {
    throw acknowledgementError(`Cloud acknowledgement ${mutation.mutationId} has invalid delete state.`);
  }

  if (acknowledgement.status !== 'conflict') {
    const expectedDeleted = mutation.operation === 'delete';
    if (rowIsDeleted !== expectedDeleted) {
      throw acknowledgementError(`Cloud acknowledgement ${mutation.mutationId} changed delete state.`);
    }
    if (!expectedDeleted && !samePayload(row.payload, mutation.payload)) {
      throw acknowledgementError(`Cloud acknowledgement ${mutation.mutationId} changed payload.`);
    }
    if (
      acknowledgement.status === 'applied'
      && mutation.baseRevision !== null
      && row.revision <= mutation.baseRevision
    ) {
      throw acknowledgementError(`Cloud acknowledgement ${mutation.mutationId} did not advance revision.`);
    }
  }
}

function expectationForRow(row: CloudRow): CloudVerificationExpectation {
  return {
    entity: row.entity,
    entityId: row.id,
    minimumRevision: row.revision,
    deleted: Boolean(row.deletedAt),
  };
}

export async function runInitialMigration(
  options: InitialMigrationOptions,
): Promise<InitialMigrationResult> {
  await options.waitForHydration();

  const localSnapshotBackup = options.localRows.map((row) => normalizeRow(row, options.ownerId));
  await options.persistLocalBackup(localSnapshotBackup.map(cloneRow));

  // A full remote pull is deliberately first: remote rows and tombstones always win conflicts.
  const initialRemote = await options.repository.pull(options.ownerId);
  assertRowsBelongToOwner(initialRemote.rows, options.ownerId);
  const remoteByKey = new Map(initialRemote.rows.map((row) => [cloudRowKey(row), row]));
  const expectedRows = new Map(initialRemote.rows.map((row) => [cloudRowKey(row), cloneRow(row)]));
  const conflictBackups: CloudRow[] = [];
  const missingLocalRows: CloudRow[] = [];

  for (const localRow of localSnapshotBackup) {
    const remoteRow = remoteByKey.get(cloudRowKey(localRow));
    if (!remoteRow) {
      missingLocalRows.push(localRow);
    } else if (rowsDiffer(localRow, remoteRow)) {
      conflictBackups.push(cloneRow(localRow));
    }
  }

  for (const localRow of missingLocalRows) {
    const mutation = migrationMutation(options.ownerId, localRow);
    const acknowledgement = await options.repository.applyMutation(mutation);
    assertAcknowledgement(mutation, acknowledgement);
    if (acknowledgement.status === 'conflict') {
      conflictBackups.push(cloneRow(localRow));
    }
    if (acknowledgement.row) {
      expectedRows.set(cloudRowKey(acknowledgement.row), cloneRow(acknowledgement.row));
    }
  }

  const authoritative = await options.repository.pull(options.ownerId);
  assertRowsBelongToOwner(authoritative.rows, options.ownerId);
  for (const row of authoritative.rows) {
    expectedRows.set(cloudRowKey(row), cloneRow(row));
  }

  const verification = await options.repository.verify(
    options.ownerId,
    [...expectedRows.values()].map(expectationForRow),
  );
  if (!verification.verified) {
    const details = verification.failures
      .map(({ expectation, reason }) => `${expectation.entity}:${expectation.entityId} (${reason})`)
      .join(', ');
    throw new CloudRepositoryError(
      'verification-failed',
      `Cloud verification failed for: ${details || 'unknown rows'}.`,
      true,
    );
  }

  const syncPhase = conflictBackups.length > 0 ? 'conflict-backed-up' : 'synced';
  const completion: MigrationCompletion = {
    rows: authoritative.rows.map(cloneRow),
    conflictBackups: conflictBackups.map(cloneRow),
    cursor: authoritative.cursor,
    migrationComplete: true,
    syncPhase,
  };
  await options.markMigrationComplete({
    ...completion,
    rows: completion.rows.map(cloneRow),
    conflictBackups: completion.conflictBackups.map(cloneRow),
  });
  return {
    ...completion,
    localSnapshotBackup: localSnapshotBackup.map(cloneRow),
  };
}

/** attempts is the persisted number of failed attempts, starting at one. */
export function getRetryDelayMs(attempts: number): number {
  const safeAttempt = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
  return RETRY_DELAYS_MS[Math.min(safeAttempt - 1, RETRY_DELAYS_MS.length - 1)];
}

export function requiresFullPull(
  lastSyncedAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (lastSyncedAt === null || lastSyncedAt === undefined) return false;
  const lastSyncMs = lastSyncedAt instanceof Date
    ? lastSyncedAt.getTime()
    : new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(lastSyncMs)) return true;
  return now.getTime() - lastSyncMs > NINETY_DAYS_MS;
}

export function isAuthFailure(error: unknown): boolean {
  if (error instanceof CloudRepositoryError) return error.code === 'auth';
  if (!error || typeof error !== 'object') return false;

  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  if (candidate.status === 401 || candidate.status === 403) return true;
  if (candidate.code === 'PGRST301' || candidate.code === 'invalid_jwt') return true;
  return typeof candidate.message === 'string'
    && /(?:invalid|expired|missing)\s+(?:jwt|token)|not authenticated/i.test(candidate.message);
}

function desiredStateMatchesRemote(mutation: OutboxMutation, remoteRow: CloudRow | null): boolean {
  if (!remoteRow) return false;
  if (mutation.operation === 'delete') return Boolean(remoteRow.deletedAt);
  return !remoteRow.deletedAt && samePayload(mutation.payload, remoteRow.payload);
}

function staleConflictReason(
  mutation: OutboxMutation,
  remoteRow: CloudRow | null,
): OutboxConflictBackup['reason'] {
  if (!remoteRow) return 'remote-missing';
  if (remoteRow.deletedAt) return 'remote-deleted';
  if (mutation.baseRevision === null) return 'remote-exists';
  return 'remote-newer';
}

function conflictBackup(
  mutation: OutboxMutation,
  remoteRow: CloudRow | null,
  reason: OutboxConflictBackup['reason'],
): OutboxConflictBackup {
  return {
    mutation: cloneMutation(mutation),
    remoteRow: remoteRow ? cloneRow(remoteRow) : null,
    reason,
  };
}

interface SuccessfulRowChain {
  acceptedBaseRevisions: ReadonlySet<number | null>;
  currentRevision: number;
}

function successfulRowChainAccepts(
  chain: SuccessfulRowChain,
  baseRevision: number | null,
): boolean {
  return chain.acceptedBaseRevisions.has(baseRevision);
}

function carryForwardSuccessfulRowChain(
  mutations: readonly OutboxMutation[],
  settledMutationKeys: ReadonlySet<string>,
  failedMutation: OutboxMutation,
  chain: SuccessfulRowChain,
): OutboxMutation[] {
  const failedRowKey = mutationRowKey(failedMutation);
  return mutations.map((mutation) => {
    const cloned = cloneMutation(mutation);
    if (
      settledMutationKeys.has(outboxMutationKey(mutation))
      || mutationRowKey(mutation) !== failedRowKey
      || !successfulRowChainAccepts(chain, mutation.baseRevision)
    ) {
      return cloned;
    }

    return { ...cloned, baseRevision: chain.currentRevision };
  });
}

function pendingAfterSettlement(
  mutations: readonly OutboxMutation[],
  settledMutationKeys: ReadonlySet<string>,
  failedMutation?: OutboxMutation,
): OutboxMutation[] {
  const failedKey = failedMutation ? outboxMutationKey(failedMutation) : null;
  return mutations
    .filter((mutation) => !settledMutationKeys.has(outboxMutationKey(mutation)))
    .map((mutation) => (
      failedKey !== null && outboxMutationKey(mutation) === failedKey
        ? {
            ...cloneMutation(mutation),
            baseRevision: failedMutation?.baseRevision ?? mutation.baseRevision,
            attempts: mutation.attempts + 1,
          }
        : cloneMutation(mutation)
    ));
}

function acknowledgedList(
  acknowledgements: ReadonlyMap<string, AcknowledgedMutation>,
): AcknowledgedMutation[] {
  return [...acknowledgements.values()].map((acknowledgement) => ({ ...acknowledgement }));
}

async function persistFailure(
  mutations: readonly OutboxMutation[],
  settledMutationKeys: ReadonlySet<string>,
  acknowledgements: ReadonlyMap<string, AcknowledgedMutation>,
  discardedMutations: readonly MutationKey[],
  conflictBackups: readonly OutboxConflictBackup[],
  failedMutation: OutboxMutation,
  error: unknown,
  options: FlushOutboxOptions,
): Promise<FlushOutboxResult> {
  const pending = pendingAfterSettlement(mutations, settledMutationKeys, failedMutation);
  await options.commitOutbox(pending.map(cloneMutation));

  const authFailure = isAuthFailure(error);
  const retryable = error instanceof CloudRepositoryError ? error.retryable : true;
  const failedAttempts = failedMutation.attempts + 1;
  return {
    pending,
    acknowledgedMutations: acknowledgedList(acknowledgements),
    discardedMutations: discardedMutations.map((key) => ({ ...key })),
    conflictBackups: conflictBackups.map((backup) => conflictBackup(
      backup.mutation,
      backup.remoteRow,
      backup.reason,
    )),
    syncPhase: authFailure ? 'reauth-required' : retryable ? 'pending' : 'error',
    retryDelayMs: authFailure || !retryable ? null : getRetryDelayMs(failedAttempts),
  };
}

export async function flushOutbox(
  mutations: readonly OutboxMutation[],
  repository: CloudRepository,
  options: FlushOutboxOptions,
): Promise<FlushOutboxResult> {
  const originalMutations = mutations.map(cloneMutation);
  assertDuplicateMutationIntegrity(originalMutations);
  const settledMutationKeys = new Set<string>();
  const acknowledgements = new Map<string, AcknowledgedMutation>();
  const discardedMutations: MutationKey[] = [];
  const conflictBackups: OutboxConflictBackup[] = [];

  if (originalMutations.length === 0) {
    await options.commitOutbox([]);
    return {
      pending: [],
      acknowledgedMutations: [],
      discardedMutations: [],
      conflictBackups: [],
      syncPhase: 'synced',
      retryDelayMs: null,
    };
  }

  const activeOwnerId = options.ownerId ?? originalMutations[0].ownerId;
  const activeMutations = originalMutations.filter(
    (mutation) => mutation.ownerId === activeOwnerId,
  );
  const successfulRowChains = new Map<string, SuccessfulRowChain>();

  if (activeMutations.length === 0) {
    await options.commitOutbox(originalMutations.map(cloneMutation));
    return {
      pending: originalMutations,
      acknowledgedMutations: [],
      discardedMutations: [],
      conflictBackups: [],
      syncPhase: 'pending',
      retryDelayMs: null,
    };
  }

  if (requiresFullPull(options.lastSyncedAt, options.now)) {
    let remoteRows: CloudRow[];
    try {
      const remote = await repository.pull(activeOwnerId);
      assertRowsBelongToOwner(remote.rows, activeOwnerId);
      remoteRows = remote.rows;
    } catch (error) {
      return persistFailure(
        originalMutations,
        settledMutationKeys,
        acknowledgements,
        discardedMutations,
        conflictBackups,
        activeMutations[0],
        error,
        options,
      );
    }

    const remoteByKey = new Map(remoteRows.map((row) => [cloudRowKey(row), row]));
    const receiptRecoveryRowKeys = new Set<string>();
    for (const mutation of activeMutations) {
      const remoteRow = remoteByKey.get(entityRowKey(mutation.entity, mutation.entityId)) ?? null;
      const preconditionStillMatches = mutation.baseRevision === null
        ? remoteRow === null
        : remoteRow?.revision === mutation.baseRevision;
      const wouldResurrect = mutation.operation === 'upsert' && Boolean(remoteRow?.deletedAt);
      if (
        (!preconditionStillMatches || wouldResurrect)
        && desiredStateMatchesRemote(mutation, remoteRow)
      ) {
        receiptRecoveryRowKeys.add(mutationRowKey(mutation));
      }
    }

    const receiptCandidates = new Map<string, OutboxMutation>();
    for (const mutation of activeMutations) {
      const key = outboxMutationKey(mutation);
      if (
        receiptRecoveryRowKeys.has(mutationRowKey(mutation))
        && !receiptCandidates.has(key)
      ) {
        receiptCandidates.set(key, mutation);
      }
    }

    const receiptsByMutationKey = new Map<string, MutationAcknowledgement>();
    const invalidReceiptRowKeys = new Set<string>();
    if (receiptCandidates.size > 0) {
      const candidateList = [...receiptCandidates.values()];
      const receiptFailureMutation = candidateList[0];
      let receipts: MutationAcknowledgement[];
      try {
        receipts = await repository.getMutationReceipts(
          activeOwnerId,
          candidateList.map((mutation) => mutation.mutationId),
        );
      } catch (error) {
        return persistFailure(
          originalMutations,
          settledMutationKeys,
          acknowledgements,
          discardedMutations,
          conflictBackups,
          receiptFailureMutation,
          error,
          options,
        );
      }

      const candidatesByMutationId = new Map(
        candidateList.map((mutation) => [mutation.mutationId, mutation]),
      );
      for (const receipt of receipts) {
        const candidate = candidatesByMutationId.get(receipt.mutationId);
        if (!candidate) {
          for (const rowKey of receiptRecoveryRowKeys) invalidReceiptRowKeys.add(rowKey);
          continue;
        }

        const candidateRowKey = mutationRowKey(candidate);
        try {
          assertAcknowledgement(candidate, receipt);
        } catch {
          invalidReceiptRowKeys.add(candidateRowKey);
          continue;
        }

        const receiptKey = outboxMutationKey(receipt);
        const previous = receiptsByMutationKey.get(receiptKey);
        if (previous && !jsonValuesEqual(previous, receipt)) {
          invalidReceiptRowKeys.add(candidateRowKey);
          continue;
        }
        receiptsByMutationKey.set(receiptKey, receipt);
      }
    }

    const recoveryMutationsByRow = new Map<string, OutboxMutation[]>();
    for (const mutation of receiptCandidates.values()) {
      const rowKey = mutationRowKey(mutation);
      const rowMutations = recoveryMutationsByRow.get(rowKey) ?? [];
      rowMutations.push(mutation);
      recoveryMutationsByRow.set(rowKey, rowMutations);
    }

    for (const [rowKey, rowMutations] of recoveryMutationsByRow) {
      const firstMutation = rowMutations[0];
      if (!firstMutation) continue;
      const remoteRow = remoteByKey.get(
        entityRowKey(firstMutation.entity, firstMutation.entityId),
      ) ?? null;
      if (!remoteRow) continue;

      let matchingReceiptIndex = -1;
      for (let index = 0; index < rowMutations.length; index += 1) {
        const receipt = receiptsByMutationKey.get(outboxMutationKey(rowMutations[index]));
        if (
          receipt?.status === 'applied'
          && receipt.row
          && rowsAreTheSameVersion(receipt.row, remoteRow)
        ) {
          matchingReceiptIndex = index;
        }
      }
      if (matchingReceiptIndex < 0) continue;

      const acceptedBaseRevisions = new Set<number | null>([firstMutation.baseRevision]);
      let previousReceipt: MutationAcknowledgement | null = null;
      let prefixIsContinuous = !invalidReceiptRowKeys.has(rowKey);
      for (let index = 0; index <= matchingReceiptIndex; index += 1) {
        const mutation = rowMutations[index];
        const receipt = receiptsByMutationKey.get(outboxMutationKey(mutation));
        if (
          !receipt
          || receipt.status !== 'applied'
          || !receipt.row
          || !acceptedBaseRevisions.has(mutation.baseRevision)
          || (
            previousReceipt?.row
            && (
              receipt.row.revision <= previousReceipt.row.revision
              || (Boolean(previousReceipt.row.deletedAt) && mutation.operation === 'upsert')
            )
          )
        ) {
          prefixIsContinuous = false;
          break;
        }
        acceptedBaseRevisions.add(receipt.row.revision);
        previousReceipt = receipt;
      }

      if (!prefixIsContinuous || !previousReceipt?.row) {
        invalidReceiptRowKeys.add(rowKey);
        continue;
      }

      for (let index = 0; index <= matchingReceiptIndex; index += 1) {
        const mutation = rowMutations[index];
        const receipt = receiptsByMutationKey.get(outboxMutationKey(mutation));
        if (!receipt) continue;
        const key = outboxMutationKey(mutation);
        settledMutationKeys.add(key);
        acknowledgements.set(key, {
          ownerId: receipt.ownerId,
          mutationId: receipt.mutationId,
          status: receipt.status,
        });
      }
      successfulRowChains.set(rowKey, {
        acceptedBaseRevisions: new Set(acceptedBaseRevisions),
        currentRevision: remoteRow.revision,
      });
    }

    const staleConflictBackups: OutboxConflictBackup[] = [];
    const backUpUnsettledRow = (
      leadingMutation: OutboxMutation,
      remoteRow: CloudRow | null,
    ): void => {
      const leadingKey = outboxMutationKey(leadingMutation);
      const leadingRowKey = mutationRowKey(leadingMutation);
      const affectedByKey = new Map<string, OutboxMutation>();
      for (const candidate of activeMutations) {
        const candidateKey = outboxMutationKey(candidate);
        if (
          !settledMutationKeys.has(candidateKey)
          && mutationRowKey(candidate) === leadingRowKey
          && !affectedByKey.has(candidateKey)
        ) {
          affectedByKey.set(candidateKey, candidate);
        }
      }
      for (const affected of affectedByKey.values()) {
        const affectedKey = outboxMutationKey(affected);
        const backup = conflictBackup(
          affected,
          remoteRow,
          affectedKey === leadingKey
            ? staleConflictReason(affected, remoteRow)
            : 'prior-mutation-conflict',
        );
        staleConflictBackups.push(backup);
        conflictBackups.push(backup);
        settledMutationKeys.add(affectedKey);
        discardedMutations.push({
          ownerId: affected.ownerId,
          mutationId: affected.mutationId,
        });
      }
    };

    for (const mutation of activeMutations) {
      const key = outboxMutationKey(mutation);
      if (settledMutationKeys.has(key)) continue;
      const remoteRow = remoteByKey.get(entityRowKey(mutation.entity, mutation.entityId)) ?? null;
      const rowKey = mutationRowKey(mutation);
      if (invalidReceiptRowKeys.has(rowKey)) {
        backUpUnsettledRow(mutation, remoteRow);
        continue;
      }
      const chain = successfulRowChains.get(rowKey);
      const preconditionStillMatches = mutation.baseRevision === null
        ? remoteRow === null
        : remoteRow?.revision === mutation.baseRevision;
      const wouldResurrect = mutation.operation === 'upsert' && Boolean(remoteRow?.deletedAt);
      const canContinueRestoredChain = Boolean(
        chain
        && remoteRow
        && remoteRow.revision === chain.currentRevision
        && successfulRowChainAccepts(chain, mutation.baseRevision)
        && !wouldResurrect
      );
      if ((preconditionStillMatches && !wouldResurrect) || canContinueRestoredChain) continue;

      if (desiredStateMatchesRemote(mutation, remoteRow)) {
        settledMutationKeys.add(key);
        discardedMutations.push({ ownerId: mutation.ownerId, mutationId: mutation.mutationId });
        continue;
      }

      backUpUnsettledRow(mutation, remoteRow);
    }

    if (staleConflictBackups.length > 0) {
      await options.persistConflictBackups(staleConflictBackups.map((backup) => conflictBackup(
        backup.mutation,
        backup.remoteRow,
        backup.reason,
      )));
    }
  }

  for (const mutation of activeMutations) {
    const key = outboxMutationKey(mutation);
    if (settledMutationKeys.has(key)) continue;

    const rowKey = mutationRowKey(mutation);
    const chain = successfulRowChains.get(rowKey);
    const canRebase = chain && successfulRowChainAccepts(chain, mutation.baseRevision);
    const effectiveMutation = canRebase
      ? { ...cloneMutation(mutation), baseRevision: chain.currentRevision }
      : mutation;

    try {
      const acknowledgement = await repository.applyMutation(effectiveMutation);
      assertAcknowledgement(effectiveMutation, acknowledgement);
      if (acknowledgement.status === 'conflict') {
        const affectedByKey = new Map<string, OutboxMutation>();
        for (const candidate of activeMutations) {
          const candidateKey = outboxMutationKey(candidate);
          if (
            !settledMutationKeys.has(candidateKey)
            && candidate.ownerId === mutation.ownerId
            && candidate.entity === mutation.entity
            && candidate.entityId === mutation.entityId
            && !affectedByKey.has(candidateKey)
          ) {
            affectedByKey.set(candidateKey, candidate);
          }
        }
        const affectedMutations = [...affectedByKey.values()];
        const rowConflictBackups = affectedMutations.map((candidate) => conflictBackup(
          candidate,
          acknowledgement.row,
          candidate.mutationId === mutation.mutationId
            ? 'server-conflict'
            : 'prior-mutation-conflict',
        ));
        await options.persistConflictBackups(rowConflictBackups);
        conflictBackups.push(...rowConflictBackups);
        for (const affected of affectedMutations) {
          const affectedKey = outboxMutationKey(affected);
          settledMutationKeys.add(affectedKey);
          discardedMutations.push({
            ownerId: affected.ownerId,
            mutationId: affected.mutationId,
          });
        }
      } else if (acknowledgement.row) {
        const acceptedBaseRevisions = new Set(chain?.acceptedBaseRevisions ?? []);
        acceptedBaseRevisions.add(mutation.baseRevision);
        acceptedBaseRevisions.add(effectiveMutation.baseRevision);
        acceptedBaseRevisions.add(acknowledgement.row.revision);
        successfulRowChains.set(rowKey, {
          acceptedBaseRevisions,
          currentRevision: acknowledgement.row.revision,
        });
      }
      settledMutationKeys.add(key);
      acknowledgements.set(key, {
        ownerId: acknowledgement.ownerId,
        mutationId: acknowledgement.mutationId,
        status: acknowledgement.status,
      });
    } catch (error) {
      const durableMutations = chain
        ? carryForwardSuccessfulRowChain(
            originalMutations,
            settledMutationKeys,
            effectiveMutation,
            chain,
          )
        : originalMutations;
      return persistFailure(
        durableMutations,
        settledMutationKeys,
        acknowledgements,
        discardedMutations,
        conflictBackups,
        effectiveMutation,
        error,
        options,
      );
    }
  }

  const pending = pendingAfterSettlement(originalMutations, settledMutationKeys);
  await options.commitOutbox(pending.map(cloneMutation));
  return {
    pending,
    acknowledgedMutations: acknowledgedList(acknowledgements),
    discardedMutations: discardedMutations.map((key) => ({ ...key })),
    conflictBackups: conflictBackups.map((backup) => conflictBackup(
      backup.mutation,
      backup.remoteRow,
      backup.reason,
    )),
    syncPhase: pending.length > 0 ? 'pending' : 'synced',
    retryDelayMs: null,
  };
}
