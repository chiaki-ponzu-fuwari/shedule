import {
  CURRENT_PERSONAL_SCHEMA_VERSION,
  type CloudEntity,
  type OutboxMutation,
} from '../../types/account';
import {
  assertTripItemWithinActiveParent,
  tripFromCloudPayload,
  tripItemFromCloudPayload,
} from './tripMapper';

export interface CloudRow {
  ownerId: string;
  entity: CloudEntity;
  id: string;
  revision: number;
  payload: Record<string, unknown> | null;
  updatedAt: string;
  deletedAt?: string;
  schemaVersion: number;
}

export type CloudRowSeed = Pick<CloudRow, 'id' | 'revision' | 'payload'> &
  Partial<Pick<CloudRow, 'ownerId' | 'entity' | 'updatedAt' | 'deletedAt' | 'schemaVersion'>> & {
    /** Test-only seed ordering; consumers must treat returned cursors as opaque. */
    changeSequence?: number;
  };

export interface CloudPullResult {
  rows: CloudRow[];
  cursor: string;
}

export type MutationAcknowledgementStatus = 'applied' | 'conflict';

export interface MutationAcknowledgement {
  mutationId: string;
  ownerId: string;
  entity: CloudEntity;
  entityId: string;
  status: MutationAcknowledgementStatus;
  revision: number | null;
  deleted: boolean;
  row: CloudRow | null;
  schemaVersion: number | null;
}

export interface CloudVerificationExpectation {
  entity: CloudEntity;
  entityId: string;
  minimumRevision: number;
  deleted: boolean;
}

export interface CloudVerificationFailure {
  expectation: CloudVerificationExpectation;
  reason: 'missing' | 'revision-too-old' | 'deletion-state-mismatch';
}

export interface CloudVerificationResult {
  verified: boolean;
  failures: CloudVerificationFailure[];
}

/**
 * The server implementation must apply `baseRevision` atomically:
 * null is insert-if-absent; a number is compare-and-swap against that revision.
 */
export interface CloudRepository {
  pull(ownerId: string, cursor?: string): Promise<CloudPullResult>;
  getMutationReceipts(
    ownerId: string,
    mutationIds: readonly string[],
  ): Promise<MutationAcknowledgement[]>;
  applyMutation(mutation: OutboxMutation): Promise<MutationAcknowledgement>;
  verify(
    ownerId: string,
    expectations: readonly CloudVerificationExpectation[],
  ): Promise<CloudVerificationResult>;
}

export type CloudRepositoryErrorCode =
  | 'offline'
  | 'auth'
  | 'ack-mismatch'
  | 'verification-failed'
  | 'owner-scope-violation'
  | 'outbox-corruption'
  | 'unsupported-schema-version'
  | 'invalid-cursor'
  | 'repository-error';

export class CloudRepositoryError extends Error {
  constructor(
    public readonly code: CloudRepositoryErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'CloudRepositoryError';
  }
}

export type MemoryRepositoryCall =
  | { method: 'pull'; ownerId: string; cursor: string | undefined }
  | { method: 'getMutationReceipts'; ownerId: string; mutationIds: string[] }
  | { method: 'applyMutation'; ownerId: string; mutationId: string; entityId: string }
  | {
      method: 'verify';
      ownerId: string;
      expectations: CloudVerificationExpectation[];
    };

export interface MemoryCloudRepositoryOptions {
  defaultOwnerId?: string;
  offline?: boolean;
  authFailure?: boolean;
  verificationFails?: boolean;
}

interface StoredCloudRow {
  row: CloudRow;
  changeSequence: number;
}

const DEFAULT_OWNER_ID = 'u1';
const DEFAULT_ENTITY: CloudEntity = 'calendar-entry';
const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export function readPersonalSchemaVersion(value: unknown, label: string): number {
  // Versionless durable rows predate schema tagging and are always v1. Keep
  // this literal stable when CURRENT advances during a rolling deployment.
  const version = value === undefined ? 1 : value;
  if (!Number.isSafeInteger(version) || Number(version) < 1) {
    throw new CloudRepositoryError('repository-error', `Invalid ${label} schema version.`, false);
  }
  return Number(version);
}

export function requireCurrentPersonalSchemaVersion(value: unknown, label: string): number {
  const version = readPersonalSchemaVersion(value, label);
  if (version !== CURRENT_PERSONAL_SCHEMA_VERSION) {
    throw new CloudRepositoryError(
      'unsupported-schema-version',
      `${label} uses unsupported schema version ${version}.`,
      false,
    );
  }
  return version;
}

function rowKey(entity: CloudEntity, id: string): string {
  return `${entity}\u0000${id}`;
}

function acknowledgementKey(ownerId: string, mutationId: string): string {
  return `${ownerId}\u0000${mutationId}`;
}

function clonePayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  return payload === null ? null : JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function cloneRow(row: CloudRow): CloudRow {
  return { ...row, payload: clonePayload(row.payload) };
}

function cloneAcknowledgement(
  acknowledgement: MutationAcknowledgement,
): MutationAcknowledgement {
  return {
    ...acknowledgement,
    row: acknowledgement.row ? cloneRow(acknowledgement.row) : null,
  };
}

function makeCursor(ownerId: string, changeSequence: number): string {
  return `memory:${encodeURIComponent(ownerId)}:${changeSequence}`;
}

function parseCursor(ownerId: string, cursor: string): number {
  const match = /^memory:([^:]+):(\d+)$/.exec(cursor);
  if (!match || decodeURIComponent(match[1]) !== ownerId) {
    throw new CloudRepositoryError(
      'owner-scope-violation',
      'The cloud cursor does not belong to the active owner.',
      false,
    );
  }
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new CloudRepositoryError('invalid-cursor', 'The cloud cursor is invalid.', false);
  }
  return sequence;
}

export class MemoryCloudRepository implements CloudRepository {
  readonly calls: MemoryRepositoryCall[] = [];
  readonly appliedMutationIds: string[] = [];

  private readonly defaultOwnerId: string;
  private readonly options: MemoryCloudRepositoryOptions;
  private readonly rowsByOwner = new Map<string, Map<string, StoredCloudRow>>();
  private readonly maxRevisionByOwner = new Map<string, number>();
  private readonly changeSequenceByOwner = new Map<string, number>();
  private readonly acknowledgements = new Map<string, MutationAcknowledgement>();

  constructor(rows: readonly CloudRowSeed[], options: MemoryCloudRepositoryOptions = {}) {
    this.defaultOwnerId = options.defaultOwnerId ?? DEFAULT_OWNER_ID;
    this.options = options;

    for (const seed of rows) {
      const ownerId = seed.ownerId ?? this.defaultOwnerId;
      const entity = seed.entity ?? DEFAULT_ENTITY;
      const changeSequence = seed.changeSequence
        ?? (this.changeSequenceByOwner.get(ownerId) ?? 0) + 1;
      const row: CloudRow = {
        ownerId,
        entity,
        id: seed.id,
        revision: seed.revision,
        payload: seed.deletedAt ? null : clonePayload(seed.payload),
        updatedAt: seed.updatedAt ?? seed.deletedAt ?? DEFAULT_TIMESTAMP,
        schemaVersion: readPersonalSchemaVersion(seed.schemaVersion, `Cloud row ${seed.id}`),
        ...(seed.deletedAt ? { deletedAt: seed.deletedAt } : {}),
      };
      this.ownerRows(ownerId).set(rowKey(entity, seed.id), { row, changeSequence });
      this.maxRevisionByOwner.set(
        ownerId,
        Math.max(this.maxRevisionByOwner.get(ownerId) ?? 0, seed.revision),
      );
      this.changeSequenceByOwner.set(
        ownerId,
        Math.max(this.changeSequenceByOwner.get(ownerId) ?? 0, changeSequence),
      );
    }
  }

  /** Convenience inspection view for the default owner in repository-level tests. */
  get rows(): ReadonlyMap<string, CloudRow> {
    return this.rowsFor(this.defaultOwnerId);
  }

  rowsFor(ownerId: string): ReadonlyMap<string, CloudRow> {
    const result = new Map<string, CloudRow>();
    for (const stored of this.ownerRows(ownerId).values()) {
      result.set(stored.row.id, cloneRow(stored.row));
    }
    return result;
  }

  async pull(ownerId: string, cursor?: string): Promise<CloudPullResult> {
    this.calls.push({ method: 'pull', ownerId, cursor });
    this.assertAvailable();

    const afterSequence = cursor === undefined ? -1 : parseCursor(ownerId, cursor);
    const rows = [...this.ownerRows(ownerId).values()]
      .filter((stored) => stored.changeSequence > afterSequence)
      .sort((a, b) => a.changeSequence - b.changeSequence)
      .map((stored) => cloneRow(stored.row));

    return {
      rows,
      cursor: makeCursor(ownerId, this.changeSequenceByOwner.get(ownerId) ?? 0),
    };
  }

  async applyMutation(mutation: OutboxMutation): Promise<MutationAcknowledgement> {
    this.calls.push({
      method: 'applyMutation',
      ownerId: mutation.ownerId,
      mutationId: mutation.mutationId,
      entityId: mutation.entityId,
    });
    this.assertAvailable();
    const schemaVersion = requireCurrentPersonalSchemaVersion(
      mutation.schemaVersion,
      `Mutation ${mutation.mutationId}`,
    );

    const ackKey = acknowledgementKey(mutation.ownerId, mutation.mutationId);
    const previousAcknowledgement = this.acknowledgements.get(ackKey);
    if (previousAcknowledgement) {
      return cloneAcknowledgement(previousAcknowledgement);
    }

    if (
      mutation.baseRevision !== null
      && (!Number.isSafeInteger(mutation.baseRevision) || mutation.baseRevision < 0)
    ) {
      throw new CloudRepositoryError('repository-error', 'Invalid base revision.', false);
    }

    const ownerRows = this.ownerRows(mutation.ownerId);
    const key = rowKey(mutation.entity, mutation.entityId);
    const existing = ownerRows.get(key)?.row ?? null;
    const preconditionMatches = mutation.baseRevision === null
      ? existing === null
      : existing?.revision === mutation.baseRevision;
    const wouldResurrect = mutation.operation === 'upsert' && Boolean(existing?.deletedAt);

    if (!preconditionMatches || wouldResurrect) {
      const acknowledgement = this.createAcknowledgement(mutation, 'conflict', existing);
      this.acknowledgements.set(ackKey, cloneAcknowledgement(acknowledgement));
      return cloneAcknowledgement(acknowledgement);
    }

    if (mutation.operation === 'upsert') {
      try {
        if (mutation.entity === 'trip') {
          const candidate = tripFromCloudPayload(mutation.entityId, mutation.payload);
          for (const stored of ownerRows.values()) {
            const child = stored.row;
            if (
              child.entity !== 'trip-item'
              || child.deletedAt
              || child.payload?.tripId !== mutation.entityId
            ) continue;
            assertTripItemWithinActiveParent(
              tripItemFromCloudPayload(child.id, child.payload),
              [candidate],
            );
          }
        } else if (mutation.entity === 'trip-item') {
          const candidate = tripItemFromCloudPayload(mutation.entityId, mutation.payload);
          const parent = ownerRows.get(rowKey('trip', candidate.tripId))?.row;
          if (!parent || parent.deletedAt || !parent.payload) {
            throw new Error(`Trip item ${candidate.id} has no active parent`);
          }
          assertTripItemWithinActiveParent(
            candidate,
            [tripFromCloudPayload(parent.id, parent.payload)],
          );
        }
      } catch (error) {
        throw new CloudRepositoryError(
          'repository-error',
          error instanceof Error ? error.message : 'Invalid travel mutation.',
          false,
        );
      }
    }

    const revision = (this.maxRevisionByOwner.get(mutation.ownerId) ?? 0) + 1;
    const changeSequence = (this.changeSequenceByOwner.get(mutation.ownerId) ?? 0) + 1;
    const isDelete = mutation.operation === 'delete';
    const row: CloudRow = {
      ownerId: mutation.ownerId,
      entity: mutation.entity,
      id: mutation.entityId,
      revision,
      payload: isDelete ? null : clonePayload(mutation.payload),
      updatedAt: mutation.createdAt,
      schemaVersion,
      ...(isDelete ? { deletedAt: mutation.createdAt } : {}),
    };

    ownerRows.set(key, { row, changeSequence });
    this.maxRevisionByOwner.set(mutation.ownerId, revision);
    this.changeSequenceByOwner.set(mutation.ownerId, changeSequence);

    if (mutation.entity === 'trip' && isDelete) {
      let cascadeRevision = revision;
      let cascadeSequence = changeSequence;
      for (const [childKey, stored] of ownerRows) {
        const child = stored.row;
        if (
          child.entity !== 'trip-item'
          || child.deletedAt
          || child.payload?.tripId !== mutation.entityId
        ) continue;
        cascadeRevision += 1;
        cascadeSequence += 1;
        ownerRows.set(childKey, {
          changeSequence: cascadeSequence,
          row: {
            ...cloneRow(child),
            revision: cascadeRevision,
            payload: null,
            updatedAt: mutation.createdAt,
            deletedAt: mutation.createdAt,
          },
        });
      }
      this.maxRevisionByOwner.set(mutation.ownerId, cascadeRevision);
      this.changeSequenceByOwner.set(mutation.ownerId, cascadeSequence);
    }

    const acknowledgement = this.createAcknowledgement(mutation, 'applied', row);
    this.acknowledgements.set(ackKey, cloneAcknowledgement(acknowledgement));
    this.appliedMutationIds.push(mutation.mutationId);
    return cloneAcknowledgement(acknowledgement);
  }

  async getMutationReceipts(
    ownerId: string,
    mutationIds: readonly string[],
  ): Promise<MutationAcknowledgement[]> {
    this.calls.push({ method: 'getMutationReceipts', ownerId, mutationIds: [...mutationIds] });
    this.assertAvailable();

    const receipts: MutationAcknowledgement[] = [];
    const seen = new Set<string>();
    for (const mutationId of mutationIds) {
      if (seen.has(mutationId)) continue;
      seen.add(mutationId);
      const receipt = this.acknowledgements.get(acknowledgementKey(ownerId, mutationId));
      if (receipt) receipts.push(cloneAcknowledgement(receipt));
    }
    return receipts;
  }

  async verify(
    ownerId: string,
    expectations: readonly CloudVerificationExpectation[],
  ): Promise<CloudVerificationResult> {
    this.calls.push({
      method: 'verify',
      ownerId,
      expectations: expectations.map((expectation) => ({ ...expectation })),
    });
    this.assertAvailable();

    const ownerRows = this.ownerRows(ownerId);
    const failures: CloudVerificationFailure[] = [];
    for (const expectation of expectations) {
      const row = ownerRows.get(rowKey(expectation.entity, expectation.entityId))?.row;
      if (!row) {
        failures.push({ expectation: { ...expectation }, reason: 'missing' });
      } else if (row.revision < expectation.minimumRevision) {
        failures.push({ expectation: { ...expectation }, reason: 'revision-too-old' });
      } else if (Boolean(row.deletedAt) !== expectation.deleted) {
        failures.push({ expectation: { ...expectation }, reason: 'deletion-state-mismatch' });
      }
    }

    if (this.options.verificationFails && failures.length === 0) {
      const expectation = expectations[0];
      if (expectation) {
        failures.push({ expectation: { ...expectation }, reason: 'missing' });
      } else {
        return {
          verified: false,
          failures: [],
        };
      }
    }

    return { verified: failures.length === 0, failures };
  }

  private ownerRows(ownerId: string): Map<string, StoredCloudRow> {
    let rows = this.rowsByOwner.get(ownerId);
    if (!rows) {
      rows = new Map<string, StoredCloudRow>();
      this.rowsByOwner.set(ownerId, rows);
    }
    return rows;
  }

  private createAcknowledgement(
    mutation: OutboxMutation,
    status: MutationAcknowledgementStatus,
    row: CloudRow | null,
  ): MutationAcknowledgement {
    return {
      mutationId: mutation.mutationId,
      ownerId: mutation.ownerId,
      entity: mutation.entity,
      entityId: mutation.entityId,
      status,
      revision: row?.revision ?? null,
      deleted: Boolean(row?.deletedAt),
      row: row ? cloneRow(row) : null,
      schemaVersion: row?.schemaVersion ?? null,
    };
  }

  private assertAvailable(): void {
    if (this.options.authFailure) {
      throw new CloudRepositoryError('auth', 'Authentication is required.', false);
    }
    if (this.options.offline) {
      throw new CloudRepositoryError('offline', 'The cloud repository is offline.', true);
    }
  }
}

export function createMemoryCloudRepository(
  rows: readonly CloudRowSeed[] = [],
  options: MemoryCloudRepositoryOptions = {},
): MemoryCloudRepository {
  return new MemoryCloudRepository(rows, options);
}
