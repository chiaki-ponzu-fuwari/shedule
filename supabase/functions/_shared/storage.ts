type StorageError = {
  status?: number;
  statusCode?: string | number;
  code?: string;
  message?: string;
};

type StorageEntry = {
  id?: string | null;
  name: string;
  metadata?: unknown;
};

type StorageBucket = {
  list(
    prefix: string,
    options: { limit: number; offset: number; sortBy: { column: 'name'; order: 'asc' } },
  ): Promise<{ data: StorageEntry[] | null; error: StorageError | null }>;
  remove(paths: string[]): Promise<{ error: StorageError | null }>;
  copy(fromPath: string, toPath: string): Promise<{ error: StorageError | null }>;
};

export type StorageClientLike = {
  storage: { from(bucket: string): StorageBucket };
};

export class StorageDeletionIncompleteError extends Error {
  constructor() {
    super('Storage deletion made progress and must be resumed');
    this.name = 'StorageDeletionIncompleteError';
  }
}

function isFile(entry: StorageEntry): boolean {
  return Boolean(entry.id || entry.metadata);
}

function childPath(parent: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/')) {
    throw new Error('Storage returned an unsafe object name');
  }
  return parent ? `${parent}/${name}` : name;
}

async function deletePrefix(
  bucket: StorageBucket,
  prefix: string,
  budget: { remaining: number; deleted: number },
): Promise<boolean> {
  while (budget.remaining > 0) {
    const response = await bucket.list(prefix, {
      limit: Math.min(100, budget.remaining),
      offset: 0,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (response.error) throw new Error('Storage listing failed');
    const entries = response.data ?? [];
    if (entries.length === 0) return true;

    const files = entries.filter(isFile).map((entry) => childPath(prefix, entry.name));
    if (files.length > 0) {
      const removed = await bucket.remove(files);
      if (removed.error) throw new Error('Storage deletion failed');
      budget.remaining -= files.length;
      budget.deleted += files.length;
      continue;
    }

    // Supabase folders are virtual entries. Recursively empty the small set of
    // child prefixes; once all children are empty there is nothing to delete.
    for (const directory of entries) {
      const complete = await deletePrefix(bucket, childPath(prefix, directory.name), budget);
      if (!complete || budget.remaining === 0) return false;
    }
    return true;
  }
  return false;
}

export async function deleteUserStorageObjects(
  client: StorageClientLike,
  userId: string,
  maximumObjectsPerAttempt = 500,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('Storage owner is invalid');
  const budget = { remaining: maximumObjectsPerAttempt, deleted: 0 };
  for (const bucketName of ['personal-media'] as const) {
    const complete = await deletePrefix(client.storage.from(bucketName), userId, budget);
    if (!complete) throw new StorageDeletionIncompleteError();
  }
}

function duplicateCopy(error: StorageError): boolean {
  const status = Number(error.status ?? error.statusCode);
  const code = String(error.code ?? error.statusCode ?? '').toLowerCase();
  const message = String(error.message ?? '').toLowerCase();
  return status === 409 && (
    code.includes('already') ||
    code.includes('duplicate') ||
    message.includes('already exists') ||
    message.includes('duplicate')
  );
}

export async function copyUserStorageObjects(
  client: StorageClientLike,
  sourceUserId: string,
  targetUserId: string,
): Promise<{ copied: number }> {
  if (
    !/^[A-Za-z0-9_-]+$/.test(sourceUserId) ||
    !/^[A-Za-z0-9_-]+$/.test(targetUserId) ||
    sourceUserId === targetUserId
  ) throw new Error('Storage owners are invalid');

  const bucket = client.storage.from('personal-media');
  const pendingPrefixes = [sourceUserId];
  let copied = 0;
  let visited = 0;
  while (pendingPrefixes.length > 0) {
    const prefix = pendingPrefixes.shift()!;
    let offset = 0;
    while (true) {
      const response = await bucket.list(prefix, {
        limit: 100,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (response.error) throw new Error('Storage listing failed');
      const entries = response.data ?? [];
      for (const entry of entries) {
        const sourcePath = childPath(prefix, entry.name);
        if (!isFile(entry)) {
          pendingPrefixes.push(sourcePath);
          continue;
        }
        const targetPath = `${targetUserId}${sourcePath.slice(sourceUserId.length)}`;
        const result = await bucket.copy(sourcePath, targetPath);
        if (result.error && !duplicateCopy(result.error)) throw new Error('Storage copy failed');
        copied += 1;
        visited += 1;
        if (visited > 100_000) throw new Error('Storage copy exceeded the safety bound');
      }
      if (entries.length < 100) break;
      offset += entries.length;
    }
  }
  return { copied };
}
