export interface DeletionProgress {
  requestId: string | null;
  userId: string | null;
  providerComplete: boolean;
  storageComplete: boolean;
  databaseComplete: boolean;
  manualRevocationRequired: boolean;
}

export type PublicDeletionStatus =
  | 'challenged'
  | 'processing'
  | 'failed'
  | 'db-cleared'
  | 'completed';

type DeletionProgressRecord = Record<string, unknown>;

function stringValue(record: DeletionProgressRecord, snake: string, camel: string) {
  const value = record[snake] ?? record[camel];
  return typeof value === 'string' && value ? value : null;
}

function completed(record: DeletionProgressRecord, snake: string, camel: string) {
  return stringValue(record, snake, camel) !== null;
}

export function normalizeDeletionProgress(record: DeletionProgressRecord): DeletionProgress {
  return {
    requestId: stringValue(record, 'request_id', 'requestId'),
    userId: stringValue(record, 'user_id', 'userId'),
    providerComplete: completed(record, 'provider_revoked_at', 'providerRevokedAt'),
    storageComplete: completed(record, 'storage_cleared_at', 'storageClearedAt'),
    databaseComplete: completed(record, 'db_cleared_at', 'dbClearedAt'),
    manualRevocationRequired:
      record.manual_revocation_required === true
      || record.manualRevocationRequired === true,
  };
}

export function mergeDeletionProgress(
  current: DeletionProgress,
  record: DeletionProgressRecord,
): DeletionProgress {
  const next = normalizeDeletionProgress(record);
  return {
    requestId: next.requestId ?? current.requestId,
    userId: next.userId ?? current.userId,
    providerComplete: current.providerComplete || next.providerComplete,
    storageComplete: current.storageComplete || next.storageComplete,
    databaseComplete: current.databaseComplete || next.databaseComplete,
    manualRevocationRequired:
      current.manualRevocationRequired || next.manualRevocationRequired,
  };
}

export function normalizePublicDeletionStatus(value: unknown): PublicDeletionStatus {
  if (value === 'authorized' || value === 'processing') return 'processing';
  if (
    value === 'challenged'
    || value === 'failed'
    || value === 'db-cleared'
    || value === 'completed'
  ) return value;
  throw new Error('Deletion receipt returned an invalid status');
}
