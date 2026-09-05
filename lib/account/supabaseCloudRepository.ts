import type { CloudEntity, OutboxMutation } from '../../types/account';
import {
  CloudRepositoryError,
  requireCurrentPersonalSchemaVersion,
  type CloudPullResult,
  type CloudRepository,
  type CloudRow,
  type CloudVerificationExpectation,
  type CloudVerificationFailure,
  type CloudVerificationResult,
  type MutationAcknowledgement,
} from './cloudRepository';

const CURSOR_PREFIX = 'recoto-cloud-v1:';
const PULL_PAGE_SIZE = 500;
const RECEIPT_BATCH_SIZE = 100;
const MAX_PULL_PAGES = 10_000;

type SupabaseErrorLike = {
  code?: string;
  message?: string;
  status?: number;
  statusCode?: number | string;
};

type QueryResult = { data: unknown; error: SupabaseErrorLike | null };

export interface SupabaseCloudQuery {
  select(columns: string): SupabaseCloudQuery;
  eq(column: string, value: unknown): SupabaseCloudQuery;
  gt(column: string, value: unknown): SupabaseCloudQuery;
  in(column: string, values: readonly unknown[]): SupabaseCloudQuery;
  order(column: string, options?: Record<string, unknown>): SupabaseCloudQuery;
  range(from: number, to: number): Promise<QueryResult>;
}

export interface SupabaseCloudClient {
  auth: {
    getUser(): Promise<{
      data: { user: { id: string; is_anonymous?: boolean } | null };
      error: SupabaseErrorLike | null;
    }>;
  };
  from(table: string): SupabaseCloudQuery;
  rpc(name: string, input: Record<string, unknown>): Promise<QueryResult>;
}

const CLOUD_ENTITIES = new Set<CloudEntity>([
  'calendar-entry',
  'special-date',
  'preference',
  'stamp',
  'trip',
  'trip-item',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorStatus(error: SupabaseErrorLike): number | null {
  if (typeof error.status === 'number') return error.status;
  const value = Number(error.statusCode);
  return Number.isFinite(value) ? value : null;
}

function repositoryError(error: SupabaseErrorLike, fallback = 'Cloud repository request failed') {
  const code = error.code ?? '';
  const message = error.message ?? fallback;
  const status = errorStatus(error);
  if (
    status === 401
    || status === 403
    || code === 'PGRST301'
    || code === '42501'
    || /(?:invalid|expired|missing)\s+(?:jwt|token)|not authenticated/i.test(message)
  ) {
    return new CloudRepositoryError('auth', fallback, false);
  }
  if (
    status === 0
    || (status !== null && status >= 500)
    || /network|fetch failed|offline|timed?\s*out|connection/i.test(message)
  ) {
    return new CloudRepositoryError('offline', fallback, true);
  }
  return new CloudRepositoryError('repository-error', fallback, false);
}

function encodeCursor(ownerId: string, sequence: number): string {
  return `${CURSOR_PREFIX}${encodeURIComponent(ownerId)}:${sequence}`;
}

function parseCursor(ownerId: string, cursor: string): number {
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new CloudRepositoryError('invalid-cursor', 'The cloud cursor is invalid.', false);
  }
  const body = cursor.slice(CURSOR_PREFIX.length);
  const separator = body.lastIndexOf(':');
  if (separator <= 0) {
    throw new CloudRepositoryError('invalid-cursor', 'The cloud cursor is invalid.', false);
  }
  let cursorOwner: string;
  try {
    cursorOwner = decodeURIComponent(body.slice(0, separator));
  } catch {
    throw new CloudRepositoryError('invalid-cursor', 'The cloud cursor is invalid.', false);
  }
  if (cursorOwner !== ownerId) {
    throw new CloudRepositoryError(
      'owner-scope-violation',
      'The cloud cursor does not belong to the active owner.',
      false,
    );
  }
  const sequence = Number(body.slice(separator + 1));
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new CloudRepositoryError('invalid-cursor', 'The cloud cursor is invalid.', false);
  }
  return sequence;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) {
    throw new CloudRepositoryError('repository-error', `Invalid cloud ${key}.`, false);
  }
  return value;
}

function nullablePayload(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new CloudRepositoryError('repository-error', 'Invalid cloud payload.', false);
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function cloudEntity(value: unknown): CloudEntity {
  if (typeof value !== 'string' || !CLOUD_ENTITIES.has(value as CloudEntity)) {
    throw new CloudRepositoryError('repository-error', 'Invalid cloud entity.', false);
  }
  return value as CloudEntity;
}

function cloudRow(value: unknown, expectedOwnerId: string): CloudRow {
  if (!isRecord(value)) {
    throw new CloudRepositoryError('repository-error', 'Invalid cloud row.', false);
  }
  const ownerId = requiredString(value, 'ownerId');
  if (ownerId !== expectedOwnerId) {
    throw new CloudRepositoryError(
      'owner-scope-violation',
      'The server returned a row for another owner.',
      false,
    );
  }
  const revision = value.revision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
    throw new CloudRepositoryError('repository-error', 'Invalid cloud revision.', false);
  }
  const deletedAt = value.deletedAt;
  if (deletedAt !== undefined && deletedAt !== null && typeof deletedAt !== 'string') {
    throw new CloudRepositoryError('repository-error', 'Invalid deletion timestamp.', false);
  }
  const row: CloudRow = {
    ownerId,
    entity: cloudEntity(value.entity),
    id: requiredString(value, 'id'),
    revision: Number(revision),
    payload: nullablePayload(value.payload),
    updatedAt: requiredString(value, 'updatedAt'),
    schemaVersion: requireCurrentPersonalSchemaVersion(
      value.schemaVersion ?? value.schema_version,
      `Cloud row ${String(value.id ?? '')}`,
    ),
  };
  if (typeof deletedAt === 'string' && deletedAt) row.deletedAt = deletedAt;
  if (row.deletedAt && row.payload !== null) {
    throw new CloudRepositoryError('repository-error', 'A tombstone contained a payload.', false);
  }
  return row;
}

function acknowledgement(value: unknown, expectedOwnerId: string): MutationAcknowledgement {
  if (!isRecord(value)) {
    throw new CloudRepositoryError('ack-mismatch', 'Invalid mutation acknowledgement.', false);
  }
  const ownerId = value.ownerId;
  const status = value.status;
  const revision = value.revision;
  const mutationId = value.mutationId;
  const entityId = value.entityId;
  if (
    typeof ownerId !== 'string'
    || ownerId !== expectedOwnerId
    || typeof mutationId !== 'string'
    || !mutationId
    || typeof entityId !== 'string'
    || !entityId
    || typeof value.entity !== 'string'
    || !CLOUD_ENTITIES.has(value.entity as CloudEntity)
    || (status !== 'applied' && status !== 'conflict')
    || (revision !== null && (!Number.isSafeInteger(revision) || Number(revision) < 1))
    || typeof value.deleted !== 'boolean'
  ) {
    throw new CloudRepositoryError('ack-mismatch', 'Invalid mutation acknowledgement.', false);
  }
  const row = value.row === null ? null : cloudRow(value.row, expectedOwnerId);
  const rawSchemaVersion = value.schemaVersion ?? value.schema_version;
  const schemaVersion = rawSchemaVersion === null
    ? null
    : requireCurrentPersonalSchemaVersion(
        rawSchemaVersion ?? row?.schemaVersion,
        `Acknowledgement ${mutationId}`,
      );
  if (row && schemaVersion !== row.schemaVersion) {
    throw new CloudRepositoryError('ack-mismatch', 'Acknowledgement schema version did not match.', false);
  }
  return {
    mutationId,
    ownerId,
    entity: value.entity as CloudEntity,
    entityId,
    status,
    revision: revision === null ? null : Number(revision),
    deleted: value.deleted,
    row,
    schemaVersion,
  };
}

function parseServerCursor(value: unknown): number {
  const sequence = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new CloudRepositoryError('invalid-cursor', 'The server returned an invalid cursor.', false);
  }
  return sequence;
}

async function requireOwner(client: SupabaseCloudClient, ownerId: string) {
  const response = await client.auth.getUser();
  if (response.error) throw repositoryError(response.error, 'Cloud authentication failed.');
  const user = response.data.user;
  if (!user?.id) {
    throw new CloudRepositoryError('auth', 'Cloud authentication is required.', false);
  }
  if (user.id !== ownerId) {
    throw new CloudRepositoryError(
      'owner-scope-violation',
      'The active session does not own this cache.',
      false,
    );
  }
  if (user.is_anonymous === true) {
    throw new CloudRepositoryError('auth', 'Anonymous sessions cannot use personal backup.', false);
  }
}

function rowKey(entity: CloudEntity, entityId: string) {
  return `${entity}\u0000${entityId}`;
}

export class SupabaseCloudRepository implements CloudRepository {
  constructor(private readonly client: SupabaseCloudClient) {}

  async pull(ownerId: string, cursor?: string): Promise<CloudPullResult> {
    await requireOwner(this.client, ownerId);
    let afterSequence = cursor === undefined ? 0 : parseCursor(ownerId, cursor);
    const rows: CloudRow[] = [];

    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const response = await this.client.rpc('pull_personal_changes', {
        p_after_change_sequence: cursor === undefined && page === 0 ? null : afterSequence,
      });
      if (response.error) throw repositoryError(response.error, 'Cloud download failed.');
      if (!isRecord(response.data) || !Array.isArray(response.data.rows)) {
        throw new CloudRepositoryError('repository-error', 'Invalid cloud pull response.', false);
      }
      const nextSequence = parseServerCursor(response.data.cursor);
      if (nextSequence < afterSequence) {
        throw new CloudRepositoryError('invalid-cursor', 'The cloud cursor moved backwards.', false);
      }
      const pageRows = response.data.rows.map((row) => cloudRow(row, ownerId));
      rows.push(...pageRows);

      if (pageRows.length < PULL_PAGE_SIZE) {
        rows.sort((left, right) => (
          left.updatedAt.localeCompare(right.updatedAt)
          || left.entity.localeCompare(right.entity)
          || left.id.localeCompare(right.id)
        ));
        return { rows, cursor: encodeCursor(ownerId, nextSequence) };
      }
      if (nextSequence === afterSequence) {
        throw new CloudRepositoryError('invalid-cursor', 'The cloud cursor did not advance.', false);
      }
      afterSequence = nextSequence;
    }

    throw new CloudRepositoryError('repository-error', 'Cloud pull exceeded the page limit.', true);
  }

  async getMutationReceipts(
    ownerId: string,
    mutationIds: readonly string[],
  ): Promise<MutationAcknowledgement[]> {
    await requireOwner(this.client, ownerId);
    const uniqueIds = [...new Set(mutationIds)];
    const results: MutationAcknowledgement[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += RECEIPT_BATCH_SIZE) {
      const batch = uniqueIds.slice(offset, offset + RECEIPT_BATCH_SIZE);
      const response = await this.client
        .from('sync_mutations')
        .select('mutation_id,ack')
        .eq('user_id', ownerId)
        .in('mutation_id', batch)
        .order('mutation_id', { ascending: true })
        .range(0, RECEIPT_BATCH_SIZE - 1);
      if (response.error) throw repositoryError(response.error, 'Mutation receipt lookup failed.');
      if (!Array.isArray(response.data)) {
        throw new CloudRepositoryError('repository-error', 'Invalid mutation receipt response.', false);
      }
      for (const record of response.data) {
        if (!isRecord(record) || !batch.includes(String(record.mutation_id))) {
          throw new CloudRepositoryError('ack-mismatch', 'Unexpected mutation receipt.', false);
        }
        results.push(acknowledgement(record.ack, ownerId));
      }
    }
    return results;
  }

  async applyMutation(mutation: OutboxMutation): Promise<MutationAcknowledgement> {
    await requireOwner(this.client, mutation.ownerId);
    const schemaVersion = requireCurrentPersonalSchemaVersion(
      mutation.schemaVersion,
      `Mutation ${mutation.mutationId}`,
    );
    const outboundMutation: OutboxMutation = { ...mutation, schemaVersion };
    const response = await this.client.rpc('apply_personal_mutations', {
      p_mutations: [outboundMutation],
    });
    if (response.error) throw repositoryError(response.error, 'Cloud save failed.');
    if (!Array.isArray(response.data) || response.data.length !== 1) {
      throw new CloudRepositoryError('ack-mismatch', 'Missing mutation acknowledgement.', false);
    }
    const parsed = acknowledgement(response.data[0], mutation.ownerId);
    if (
      parsed.mutationId !== mutation.mutationId
      || parsed.entity !== mutation.entity
      || parsed.entityId !== mutation.entityId
    ) {
      throw new CloudRepositoryError('ack-mismatch', 'Mutation acknowledgement did not match.', false);
    }
    return parsed;
  }

  async verify(
    ownerId: string,
    expectations: readonly CloudVerificationExpectation[],
  ): Promise<CloudVerificationResult> {
    const remote = await this.pull(ownerId);
    const byKey = new Map(remote.rows.map((row) => [rowKey(row.entity, row.id), row]));
    const failures: CloudVerificationFailure[] = [];
    for (const expectation of expectations) {
      const row = byKey.get(rowKey(expectation.entity, expectation.entityId));
      let reason: CloudVerificationFailure['reason'] | null = null;
      if (!row) reason = 'missing';
      else if (row.revision < expectation.minimumRevision) reason = 'revision-too-old';
      else if (Boolean(row.deletedAt) !== expectation.deleted) reason = 'deletion-state-mismatch';
      if (reason) failures.push({ expectation: { ...expectation }, reason });
    }
    return { verified: failures.length === 0, failures };
  }
}

export function createSupabaseCloudRepository(client: SupabaseCloudClient): CloudRepository {
  return new SupabaseCloudRepository(client);
}

export { CloudRepositoryError };
