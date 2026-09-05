import type { OutboxMutation } from '../../types/account';
import type {
  CloudRepository,
  CloudRow,
  FlushOutboxOptions,
  InitialMigrationOptions,
  MutationAcknowledgement,
} from '../../lib/account/syncEngine';
import {
  CloudRepositoryError,
  createMemoryCloudRepository,
} from '../../lib/account/cloudRepository';
import {
  flushOutbox,
  getRetryDelayMs,
  requiresFullPull,
  runInitialMigration,
} from '../../lib/account/syncEngine';
import { mutationFixture } from './fixtures';

const noOp = async (): Promise<void> => {};

function migrationPersistence(
  overrides: Partial<Pick<
    InitialMigrationOptions,
    'waitForHydration' | 'persistLocalBackup' | 'markMigrationComplete'
  >> = {},
): Pick<
  InitialMigrationOptions,
  'waitForHydration' | 'persistLocalBackup' | 'markMigrationComplete'
> {
  return {
    waitForHydration: noOp,
    persistLocalBackup: noOp,
    markMigrationComplete: noOp,
    ...overrides,
  };
}

function flushPersistence(
  overrides: Partial<FlushOutboxOptions> = {},
): FlushOutboxOptions {
  return {
    ownerId: 'u1',
    commitOutbox: noOp,
    persistConflictBackups: noOp,
    ...overrides,
  };
}

function validAppliedAcknowledgement(mutation: OutboxMutation): MutationAcknowledgement {
  const row: CloudRow = {
    ownerId: mutation.ownerId,
    entity: mutation.entity,
    id: mutation.entityId,
    revision: 1,
    payload: mutation.payload,
    updatedAt: mutation.createdAt,
  };
  return {
    mutationId: mutation.mutationId,
    ownerId: mutation.ownerId,
    entity: mutation.entity,
    entityId: mutation.entityId,
    status: 'applied',
    revision: 1,
    deleted: false,
    row,
  };
}

describe('remote-first personal cloud sync', () => {
  test('hydrates and downloads remote state before uploading only missing local rows', async () => {
    const repository = createMemoryCloudRepository([
      { id: 'same', revision: 2, payload: { notes: 'remote' } },
    ]);
    const lifecycle: string[] = [];

    const result = await runInitialMigration({
      ownerId: 'u1',
      localRows: [
        { id: 'same', revision: 1, payload: { notes: 'local' } },
        { id: 'local-only', revision: 1, payload: { notes: 'new' } },
      ],
      repository,
      ...migrationPersistence({
        waitForHydration: async () => {
          lifecycle.push('hydrated');
        },
      }),
    });

    expect(lifecycle).toEqual(['hydrated']);
    expect(repository.calls.map((call) => call.method)).toEqual([
      'pull',
      'applyMutation',
      'pull',
      'verify',
    ]);
    expect(result.rows.find((row) => row.id === 'same')?.payload).toEqual({ notes: 'remote' });
    expect(repository.rows.has('local-only')).toBe(true);
    expect(result.conflictBackups).toEqual([
      expect.objectContaining({ id: 'same', payload: { notes: 'local' } }),
    ]);
    expect(result.migrationComplete).toBe(true);
    expect(repository.calls.at(-1)).toEqual(expect.objectContaining({
      method: 'verify',
      expectations: expect.arrayContaining([
        expect.objectContaining({
          entity: 'calendar-entry',
          entityId: 'same',
          minimumRevision: 2,
          deleted: false,
        }),
      ]),
    }));
  });

  test('does not mark migration complete until entity/revision/tombstone verification succeeds', async () => {
    const repository = createMemoryCloudRepository([], { verificationFails: true });
    const complete = jest.fn(async () => {});

    await expect(runInitialMigration({
      ownerId: 'u1',
      localRows: [{ id: 'local-only', revision: 1, payload: { notes: 'new' } }],
      repository,
      ...migrationPersistence({ markMigrationComplete: complete }),
    })).rejects.toMatchObject({ code: 'verification-failed' });

    expect(repository.calls.at(-1)?.method).toBe('verify');
    expect(complete).not.toHaveBeenCalled();
  });

  test('persists a copied local backup before cloud writes and marks complete after verify', async () => {
    const repository = createMemoryCloudRepository([]);
    const lifecycle: string[] = [];
    const originalApplyMutation = repository.applyMutation.bind(repository);
    const originalVerify = repository.verify.bind(repository);
    repository.applyMutation = async (mutation) => {
      lifecycle.push('upload');
      return originalApplyMutation(mutation);
    };
    repository.verify = async (ownerId, expectations) => {
      lifecycle.push('verify');
      return originalVerify(ownerId, expectations);
    };
    const localRows = [{ id: 'local', revision: 1, payload: { nested: { note: 'safe' } } }];

    const completions: unknown[] = [];
    const result = await runInitialMigration({
      ownerId: 'u1',
      localRows,
      repository,
      ...migrationPersistence({
        persistLocalBackup: async (rows) => {
          lifecycle.push('backup');
          (rows[0].payload?.nested as { note: string }).note = 'backup-copy';
        },
        markMigrationComplete: async (completion) => {
          lifecycle.push('complete');
          completions.push(completion);
        },
      }),
    });

    expect(lifecycle).toEqual(['backup', 'upload', 'verify', 'complete']);
    expect(result.localSnapshotBackup[0].payload).toEqual({ nested: { note: 'safe' } });
    expect(localRows[0].payload).toEqual({ nested: { note: 'safe' } });
    expect(result.cursor).toEqual(expect.any(String));
    expect(completions).toEqual([
      expect.objectContaining({
        cursor: result.cursor,
        rows: result.rows,
        migrationComplete: true,
      }),
    ]);
  });

  test('an insert-if-absent race keeps the new remote row and backs up local state', async () => {
    const repository = createMemoryCloudRepository([]);
    const originalApplyMutation = repository.applyMutation.bind(repository);
    let injectRace = true;
    repository.applyMutation = async (mutation) => {
      if (injectRace && mutation.mutationId.startsWith('initial:')) {
        injectRace = false;
        await originalApplyMutation(mutationFixture({
          mutationId: 'remote-race',
          entityId: mutation.entityId,
          payload: { notes: 'remote-won' },
          baseRevision: null,
        }));
      }
      return originalApplyMutation(mutation);
    };

    const result = await runInitialMigration({
      ownerId: 'u1',
      localRows: [{ id: 'raced', revision: 1, payload: { notes: 'local-lost' } }],
      repository,
      ...migrationPersistence(),
    });

    expect(repository.rows.get('raced')?.payload).toEqual({ notes: 'remote-won' });
    expect(result.rows.find((row) => row.id === 'raced')?.payload).toEqual({ notes: 'remote-won' });
    expect(result.conflictBackups).toEqual([
      expect.objectContaining({ id: 'raced', payload: { notes: 'local-lost' } }),
    ]);
  });

  test('rejects a local seed explicitly owned by another user before cloud access', async () => {
    const repository = createMemoryCloudRepository([]);

    await expect(runInitialMigration({
      ownerId: 'u1',
      localRows: [{ ownerId: 'u2', id: 'foreign', revision: 1, payload: { notes: 'secret' } }],
      repository,
      ...migrationPersistence(),
    })).rejects.toMatchObject({ code: 'owner-scope-violation' });

    expect(repository.calls).toEqual([]);
  });

  test('rejects a pull response containing another owner', async () => {
    const memory = createMemoryCloudRepository([]);
    const repository: CloudRepository = {
      pull: async () => ({
        rows: [{
          ownerId: 'u2',
          entity: 'calendar-entry',
          id: 'foreign',
          revision: 1,
          payload: { notes: 'secret' },
          updatedAt: '2026-09-05T00:00:00Z',
        }],
        cursor: 'foreign-cursor',
      }),
      getMutationReceipts: memory.getMutationReceipts.bind(memory),
      applyMutation: memory.applyMutation.bind(memory),
      verify: memory.verify.bind(memory),
    };

    await expect(runInitialMigration({
      ownerId: 'u1',
      localRows: [],
      repository,
      ...migrationPersistence(),
    })).rejects.toMatchObject({ code: 'owner-scope-violation' });
  });

  test('replaying one mutation twice writes one remote revision', async () => {
    const repository = createMemoryCloudRepository([]);
    const mutation = mutationFixture({ mutationId: 'm1', entityId: 'd1' });

    const result = await flushOutbox(
      [mutation, mutation],
      repository,
      flushPersistence(),
    );

    expect(result.pending).toEqual([]);
    expect(result.acknowledgedMutations).toEqual([
      { ownerId: 'u1', mutationId: 'm1', status: 'applied' },
    ]);
    expect(repository.appliedMutationIds).toEqual(['m1']);
    expect(repository.rows.get('d1')?.revision).toBe(1);
  });

  test('rebases consecutive offline edits to one row so the latest value reaches the cloud', async () => {
    const repository = createMemoryCloudRepository([
      { id: 'd1', revision: 5, payload: { notes: 'before-offline' } },
    ]);
    const first = mutationFixture({
      mutationId: 'offline-edit-1',
      entityId: 'd1',
      payload: { notes: 'first edit' },
      baseRevision: 5,
      createdAt: '2026-09-05T01:00:00Z',
    });
    const latest = mutationFixture({
      mutationId: 'offline-edit-2',
      entityId: 'd1',
      payload: { notes: 'latest edit' },
      baseRevision: 5,
      createdAt: '2026-09-05T02:00:00Z',
    });

    const result = await flushOutbox([first, latest], repository, flushPersistence());

    expect(result.pending).toEqual([]);
    expect(result.conflictBackups).toEqual([]);
    expect(repository.appliedMutationIds).toEqual(['offline-edit-1', 'offline-edit-2']);
    expect(repository.rows.get('d1')).toMatchObject({
      revision: 7,
      payload: { notes: 'latest edit' },
    });
  });

  test('persists rebase information for every remaining edit after a middle transient failure', async () => {
    const repository = createMemoryCloudRepository([
      { id: 'd1', revision: 5, payload: { notes: 'before-offline' } },
    ]);
    const originalApplyMutation = repository.applyMutation.bind(repository);
    let callCount = 0;
    repository.applyMutation = async (mutation) => {
      callCount += 1;
      if (callCount === 2) {
        throw new CloudRepositoryError('offline', 'offline before write', true);
      }
      return originalApplyMutation(mutation);
    };
    const first = mutationFixture({
      mutationId: 'offline-edit-1',
      baseRevision: 5,
      payload: { notes: 'first edit' },
    });
    const latest = mutationFixture({
      mutationId: 'offline-edit-2',
      baseRevision: 5,
      payload: { notes: 'middle edit' },
    });
    const third = mutationFixture({
      mutationId: 'offline-edit-3',
      baseRevision: 5,
      payload: { notes: 'latest edit' },
    });
    const commitOutbox = jest.fn(async () => {});

    const result = await flushOutbox(
      [first, latest, third],
      repository,
      flushPersistence({ commitOutbox }),
    );

    expect(result.pending).toEqual([
      { ...latest, baseRevision: 6, attempts: 1 },
      { ...third, baseRevision: 6 },
    ]);
    expect(commitOutbox).toHaveBeenCalledWith([
      { ...latest, baseRevision: 6, attempts: 1 },
      { ...third, baseRevision: 6 },
    ]);
    expect(repository.rows.get('d1')).toMatchObject({
      revision: 6,
      payload: { notes: 'first edit' },
    });

    repository.applyMutation = originalApplyMutation;
    const retry = await flushOutbox(result.pending, repository, flushPersistence());
    expect(retry.pending).toEqual([]);
    expect(repository.rows.get('d1')).toMatchObject({
      revision: 8,
      payload: { notes: 'latest edit' },
    });
  });

  test('preserves a three-mutation delete chain across a middle transient failure', async () => {
    const repository = createMemoryCloudRepository([
      { id: 'd1', revision: 5, payload: { notes: 'before-offline' } },
    ]);
    const originalApplyMutation = repository.applyMutation.bind(repository);
    let callCount = 0;
    repository.applyMutation = async (mutation) => {
      callCount += 1;
      if (callCount === 2) {
        throw new CloudRepositoryError('offline', 'offline before delete', true);
      }
      return originalApplyMutation(mutation);
    };
    const first = mutationFixture({
      mutationId: 'before-delete',
      baseRevision: 5,
      payload: { notes: 'final live edit' },
    });
    const remove = mutationFixture({
      mutationId: 'delete-1',
      operation: 'delete',
      payload: null,
      baseRevision: 5,
    });
    const repeatedRemove = mutationFixture({
      mutationId: 'delete-2',
      operation: 'delete',
      payload: null,
      baseRevision: 5,
    });

    const firstAttempt = await flushOutbox(
      [first, remove, repeatedRemove],
      repository,
      flushPersistence(),
    );

    expect(firstAttempt.pending).toEqual([
      { ...remove, baseRevision: 6, attempts: 1 },
      { ...repeatedRemove, baseRevision: 6 },
    ]);

    repository.applyMutation = originalApplyMutation;
    const retry = await flushOutbox(firstAttempt.pending, repository, flushPersistence());
    expect(retry.pending).toEqual([]);
    expect(repository.rows.get('d1')).toMatchObject({ revision: 8, payload: null });
    expect(repository.rows.get('d1')?.deletedAt).toBeDefined();
  });

  test('restores a row rebase chain from a durable applied receipt after a 90-day pull', async () => {
    const repository = createMemoryCloudRepository([
      { id: 'd1', revision: 5, payload: { notes: 'before-offline' } },
    ]);
    const first = mutationFixture({
      mutationId: 'crash-edit-1',
      baseRevision: 5,
      payload: { notes: 'first edit' },
    });
    const second = mutationFixture({
      mutationId: 'crash-edit-2',
      baseRevision: 5,
      payload: { notes: 'second edit' },
    });
    const third = mutationFixture({
      mutationId: 'crash-edit-3',
      baseRevision: 5,
      payload: { notes: 'latest edit' },
    });
    await repository.applyMutation(first);
    repository.calls.length = 0;

    const result = await flushOutbox([first, second, third], repository, flushPersistence({
      lastSyncedAt: '2026-06-06T23:59:59Z',
      now: new Date('2026-09-05T00:00:00Z'),
    }));

    expect(repository.calls.map((call) => call.method)).toEqual([
      'pull',
      'getMutationReceipts',
      'applyMutation',
      'applyMutation',
    ]);
    expect(result.pending).toEqual([]);
    expect(result.conflictBackups).toEqual([]);
    expect(result.acknowledgedMutations.map((ack) => ack.mutationId)).toEqual([
      'crash-edit-1',
      'crash-edit-2',
      'crash-edit-3',
    ]);
    expect(repository.rows.get('d1')).toMatchObject({
      revision: 8,
      payload: { notes: 'latest edit' },
    });
  });

  test('restores an applied receipt prefix before rebasing the first unsent edit', async () => {
    const repository = createMemoryCloudRepository([
      { id: 'd1', revision: 5, payload: { notes: 'before-offline' } },
    ]);
    const first = mutationFixture({
      mutationId: 'prefix-edit-1',
      baseRevision: 5,
      payload: { notes: 'first edit' },
    });
    const second = mutationFixture({
      mutationId: 'prefix-edit-2',
      baseRevision: 5,
      payload: { notes: 'second edit' },
    });
    const third = mutationFixture({
      mutationId: 'prefix-edit-3',
      baseRevision: 5,
      payload: { notes: 'latest edit' },
    });
    await repository.applyMutation(first);
    await repository.applyMutation({ ...second, baseRevision: 6 });
    repository.calls.length = 0;

    const result = await flushOutbox([first, second, third], repository, flushPersistence({
      lastSyncedAt: '2026-06-06T23:59:59Z',
      now: new Date('2026-09-05T00:00:00Z'),
    }));

    expect(repository.calls.map((call) => call.method)).toEqual([
      'pull',
      'getMutationReceipts',
      'applyMutation',
    ]);
    expect(repository.calls[1]).toEqual({
      method: 'getMutationReceipts',
      ownerId: 'u1',
      mutationIds: [first.mutationId, second.mutationId, third.mutationId],
    });
    expect(result.pending).toEqual([]);
    expect(result.conflictBackups).toEqual([]);
    expect(result.acknowledgedMutations.map((ack) => ack.mutationId)).toEqual([
      'prefix-edit-1',
      'prefix-edit-2',
      'prefix-edit-3',
    ]);
    expect(repository.rows.get('d1')).toMatchObject({
      revision: 8,
      payload: { notes: 'latest edit' },
    });
  });

  test('rebases an unsent edit based on an intermediate revision in a verified receipt prefix', async () => {
    const repository = createMemoryCloudRepository([
      { id: 'd1', revision: 5, payload: { notes: 'before-offline' } },
    ]);
    const first = mutationFixture({
      mutationId: 'intermediate-base-1',
      baseRevision: 5,
      payload: { notes: 'first edit' },
    });
    const second = mutationFixture({
      mutationId: 'intermediate-base-2',
      baseRevision: 6,
      payload: { notes: 'second edit' },
    });
    const third = mutationFixture({
      mutationId: 'intermediate-base-3',
      baseRevision: 6,
      payload: { notes: 'latest edit' },
    });
    await repository.applyMutation(first);
    await repository.applyMutation(second);
    repository.calls.length = 0;

    const result = await flushOutbox([first, second, third], repository, flushPersistence({
      lastSyncedAt: '2026-06-06T23:59:59Z',
      now: new Date('2026-09-05T00:00:00Z'),
    }));

    expect(repository.calls.map((call) => call.method)).toEqual([
      'pull',
      'getMutationReceipts',
      'applyMutation',
    ]);
    expect(result.pending).toEqual([]);
    expect(result.conflictBackups).toEqual([]);
    expect(repository.rows.get('d1')).toMatchObject({
      revision: 8,
      payload: { notes: 'latest edit' },
    });
  });

  test.each([
    ['missing leading receipt', 'missing'],
    ['non-increasing receipt revisions', 'contradictory'],
    ['foreign-owner receipt', 'foreign-owner'],
  ])('keeps remote state and backs up the row chain for %s', async (_label, fault) => {
    const memory = createMemoryCloudRepository([
      { id: 'd1', revision: 5, payload: { notes: 'before-offline' } },
    ]);
    const first = mutationFixture({
      mutationId: `unsafe-prefix-${fault}-1`,
      baseRevision: 5,
      payload: { notes: 'first edit' },
    });
    const second = mutationFixture({
      mutationId: `unsafe-prefix-${fault}-2`,
      baseRevision: 5,
      payload: { notes: 'remote winner' },
    });
    const third = mutationFixture({
      mutationId: `unsafe-prefix-${fault}-3`,
      baseRevision: 5,
      payload: { notes: 'must not upload' },
    });
    await memory.applyMutation(first);
    await memory.applyMutation({ ...second, baseRevision: 6 });
    memory.calls.length = 0;

    const repository: CloudRepository = {
      pull: memory.pull.bind(memory),
      getMutationReceipts: async (ownerId, mutationIds) => {
        const receipts = await memory.getMutationReceipts(ownerId, mutationIds);
        if (fault === 'missing') {
          return receipts.filter((receipt) => receipt.mutationId !== first.mutationId);
        }
        return receipts.map((receipt) => {
          if (receipt.mutationId !== first.mutationId || !receipt.row) return receipt;
          if (fault === 'foreign-owner') {
            return {
              ...receipt,
              ownerId: 'u2',
              row: { ...receipt.row, ownerId: 'u2' },
            };
          }
          return {
            ...receipt,
            revision: 7,
            row: { ...receipt.row, revision: 7 },
          };
        });
      },
      applyMutation: memory.applyMutation.bind(memory),
      verify: memory.verify.bind(memory),
    };

    const result = await flushOutbox([first, second, third], repository, flushPersistence({
      lastSyncedAt: '2026-06-06T23:59:59Z',
      now: new Date('2026-09-05T00:00:00Z'),
    }));

    expect(memory.calls.filter((call) => call.method === 'applyMutation')).toHaveLength(0);
    expect(memory.rows.get('d1')).toMatchObject({
      revision: 7,
      payload: { notes: 'remote winner' },
    });
    expect(result.conflictBackups.map((backup) => backup.mutation.mutationId)).toEqual([
      first.mutationId,
      second.mutationId,
      third.mutationId,
    ]);
  });

  test('does not infer an applied mutation from matching remote payload without a receipt', async () => {
    const repository = createMemoryCloudRepository([
      { id: 'd1', revision: 6, payload: { notes: 'same-looking state' } },
    ]);
    const unproven = mutationFixture({
      mutationId: 'no-receipt-1',
      baseRevision: 5,
      payload: { notes: 'same-looking state' },
    });
    const later = mutationFixture({
      mutationId: 'no-receipt-2',
      baseRevision: 5,
      payload: { notes: 'must not overwrite' },
    });

    const result = await flushOutbox([unproven, later], repository, flushPersistence({
      lastSyncedAt: '2026-06-06T23:59:59Z',
      now: new Date('2026-09-05T00:00:00Z'),
    }));

    expect(repository.calls.filter((call) => call.method === 'applyMutation')).toHaveLength(0);
    expect(repository.rows.get('d1')?.payload).toEqual({ notes: 'same-looking state' });
    expect(result.acknowledgedMutations).toEqual([]);
    expect(result.conflictBackups.map((backup) => backup.mutation.mutationId)).toEqual([
      'no-receipt-2',
    ]);
  });

  test('backs up all later edits to a row when the leading mutation conflicts', async () => {
    const repository = createMemoryCloudRepository([
      { id: 'd1', revision: 8, payload: { notes: 'other device' } },
    ]);
    const first = mutationFixture({
      mutationId: 'conflicting-1',
      baseRevision: 5,
      payload: { notes: 'local first' },
    });
    const latest = mutationFixture({
      mutationId: 'conflicting-2',
      baseRevision: 5,
      payload: { notes: 'local latest' },
    });
    const persistedConflicts: unknown[][] = [];

    const result = await flushOutbox([first, latest], repository, flushPersistence({
      persistConflictBackups: async (conflicts) => {
        persistedConflicts.push([...conflicts]);
      },
    }));

    expect(repository.calls.filter((call) => call.method === 'applyMutation')).toHaveLength(1);
    expect(repository.rows.get('d1')?.payload).toEqual({ notes: 'other device' });
    expect(result.pending).toEqual([]);
    expect(result.discardedMutations).toEqual([
      { ownerId: 'u1', mutationId: 'conflicting-1' },
      { ownerId: 'u1', mutationId: 'conflicting-2' },
    ]);
    expect(result.conflictBackups.map((backup) => backup.mutation.mutationId)).toEqual([
      'conflicting-1',
      'conflicting-2',
    ]);
    expect(persistedConflicts).toHaveLength(1);
    expect(persistedConflicts[0]).toHaveLength(2);
  });

  test('backs up exact duplicate ids only once when their row chain conflicts', async () => {
    const repository = createMemoryCloudRepository([
      { id: 'd1', revision: 8, payload: { notes: 'other device' } },
    ]);
    const duplicate = mutationFixture({
      mutationId: 'duplicate-conflict',
      baseRevision: 5,
      payload: { notes: 'local first' },
    });
    const later = mutationFixture({
      mutationId: 'later-conflict',
      baseRevision: 5,
      payload: { notes: 'local latest' },
    });

    const result = await flushOutbox(
      [duplicate, duplicate, later],
      repository,
      flushPersistence(),
    );

    expect(result.conflictBackups.map((backup) => backup.mutation.mutationId)).toEqual([
      'duplicate-conflict',
      'later-conflict',
    ]);
    expect(result.discardedMutations).toEqual([
      { ownerId: 'u1', mutationId: 'duplicate-conflict' },
      { ownerId: 'u1', mutationId: 'later-conflict' },
    ]);
  });

  test.each([
    ['entity', { entity: 'stamp' as const }],
    ['entity id', { entityId: 'different-row' }],
    ['operation', { operation: 'delete' as const, payload: null }],
    ['payload', { payload: { notes: 'replaced' } }],
    ['base revision', { baseRevision: 9 }],
    ['creation time', { createdAt: '2026-09-05T09:00:00Z' }],
  ])('rejects duplicate mutation ids with different immutable %s', async (_field, overrides) => {
    const repository = createMemoryCloudRepository([]);
    const original = mutationFixture({ mutationId: 'duplicate-corruption' });
    const corrupted = mutationFixture({
      mutationId: 'duplicate-corruption',
      ...overrides,
    });
    const commitOutbox = jest.fn(async () => {});
    const persistConflictBackups = jest.fn(async () => {});

    await expect(flushOutbox([original, corrupted], repository, flushPersistence({
      commitOutbox,
      persistConflictBackups,
    }))).rejects.toMatchObject({
      code: 'outbox-corruption',
      retryable: false,
    });

    expect(repository.calls).toEqual([]);
    expect(commitOutbox).not.toHaveBeenCalled();
    expect(persistConflictBackups).not.toHaveBeenCalled();
  });

  test('allows exact duplicate mutations with retry-attempt differences and JSON key reordering', async () => {
    const repository = createMemoryCloudRepository([]);
    const original = mutationFixture({
      mutationId: 'valid-duplicate',
      payload: { z: 1, nested: { y: 2, x: 3 } },
      attempts: 0,
    });
    const duplicate = mutationFixture({
      mutationId: 'valid-duplicate',
      payload: { nested: { x: 3, y: 2 }, z: 1 },
      attempts: 4,
    });

    const result = await flushOutbox([original, duplicate], repository, flushPersistence());

    expect(result.pending).toEqual([]);
    expect(repository.appliedMutationIds).toEqual(['valid-duplicate']);
  });

  test('a tombstone is not resurrected by a stale device', async () => {
    const repository = createMemoryCloudRepository([
      {
        id: 'd1',
        revision: 5,
        payload: null,
        deletedAt: '2026-09-01T00:00:00Z',
      },
    ]);

    const result = await runInitialMigration({
      ownerId: 'u1',
      localRows: [{ id: 'd1', revision: 2, payload: { notes: 'stale' } }],
      repository,
      ...migrationPersistence(),
    });

    expect(result.rows[0].deletedAt).toBe('2026-09-01T00:00:00Z');
    expect(repository.rows.get('d1')?.payload).toBeNull();
    expect(repository.calls.filter((call) => call.method === 'applyMutation')).toHaveLength(0);
  });

  test('a 90-day full pull discards tombstoned and newer conflicts before upload', async () => {
    const repository = createMemoryCloudRepository([
      {
        id: 'deleted',
        revision: 5,
        payload: null,
        deletedAt: '2026-09-01T00:00:00Z',
      },
      { id: 'newer', revision: 7, payload: { notes: 'remote-newer' } },
    ]);
    const deletedMutation = mutationFixture({
      mutationId: 'stale-deleted',
      entityId: 'deleted',
      payload: { notes: 'resurrect-me' },
      baseRevision: 2,
    });
    const newerMutation = mutationFixture({
      mutationId: 'stale-newer',
      entityId: 'newer',
      payload: { notes: 'overwrite-me' },
      baseRevision: 3,
    });
    const commits: OutboxMutation[][] = [];
    const backups: unknown[][] = [];

    const result = await flushOutbox([deletedMutation, newerMutation], repository, flushPersistence({
      lastSyncedAt: '2026-06-06T23:59:59Z',
      now: new Date('2026-09-05T00:00:00Z'),
      commitOutbox: async (pending) => {
        commits.push([...pending]);
      },
      persistConflictBackups: async (conflicts) => {
        backups.push([...conflicts]);
      },
    }));

    expect(repository.calls.map((call) => call.method)).toEqual(['pull']);
    expect(repository.rows.get('deleted')?.payload).toBeNull();
    expect(repository.rows.get('newer')?.payload).toEqual({ notes: 'remote-newer' });
    expect(result.pending).toEqual([]);
    expect(result.discardedMutations).toEqual([
      { ownerId: 'u1', mutationId: 'stale-deleted' },
      { ownerId: 'u1', mutationId: 'stale-newer' },
    ]);
    expect(result.conflictBackups).toHaveLength(2);
    expect(backups[0]).toHaveLength(2);
    expect(commits).toEqual([[]]);
  });

  test('deduplicates stale conflict backup and discard records by owner mutation key', async () => {
    const repository = createMemoryCloudRepository([
      { id: 'newer', revision: 7, payload: { notes: 'remote' } },
    ]);
    const mutation = mutationFixture({
      mutationId: 'duplicate-stale',
      entityId: 'newer',
      payload: { notes: 'local' },
      baseRevision: 3,
    });
    const persistedConflicts: unknown[][] = [];

    const result = await flushOutbox([mutation, mutation], repository, flushPersistence({
      lastSyncedAt: '2026-06-06T23:59:59Z',
      now: new Date('2026-09-05T00:00:00Z'),
      persistConflictBackups: async (conflicts) => {
        persistedConflicts.push([...conflicts]);
      },
    }));

    expect(result.discardedMutations).toEqual([
      { ownerId: 'u1', mutationId: 'duplicate-stale' },
    ]);
    expect(result.conflictBackups).toHaveLength(1);
    expect(persistedConflicts[0]).toHaveLength(1);
  });

  test('offline writes stay durable and increment only the attempted mutation', async () => {
    const repository = createMemoryCloudRepository([], { offline: true });
    const mutation = mutationFixture({ mutationId: 'offline-1', attempts: 0 });
    const commits: OutboxMutation[][] = [];

    const result = await flushOutbox([mutation], repository, flushPersistence({
      commitOutbox: async (pending) => {
        commits.push([...pending]);
      },
    }));

    expect(result.pending).toEqual([{ ...mutation, attempts: 1 }]);
    expect(commits).toEqual([[{ ...mutation, attempts: 1 }]]);
    expect(result.syncPhase).toBe('pending');
    expect(result.retryDelayMs).toBe(2_000);
  });

  test('uses the bounded retry schedule by failed-attempt count', () => {
    expect([0, 1, 2, 3, 4, 5, 99].map(getRetryDelayMs)).toEqual([
      2_000,
      2_000,
      5_000,
      15_000,
      60_000,
      300_000,
      300_000,
    ]);
  });

  test('auth failures stop automatic retries, persist attempts, and preserve remaining work', async () => {
    const repository = createMemoryCloudRepository([], { authFailure: true });
    const first = mutationFixture({ mutationId: 'auth-1', entityId: 'd1' });
    const second = mutationFixture({ mutationId: 'auth-2', entityId: 'd2' });
    const commitOutbox = jest.fn(async () => {});

    const result = await flushOutbox([first, second], repository, flushPersistence({ commitOutbox }));

    expect(result.pending).toEqual([{ ...first, attempts: 1 }, second]);
    expect(result.syncPhase).toBe('reauth-required');
    expect(result.retryDelayMs).toBeNull();
    expect(commitOutbox).toHaveBeenCalledWith([{ ...first, attempts: 1 }, second]);
    expect(repository.calls.filter((call) => call.method === 'applyMutation')).toHaveLength(1);
  });

  test('full-pulls before uploading when last sync is over 90 days old', async () => {
    const now = new Date('2026-09-05T00:00:00Z');
    const repository = createMemoryCloudRepository([]);
    const mutation = mutationFixture({ mutationId: 'stale-device' });

    const result = await flushOutbox([mutation], repository, flushPersistence({
      lastSyncedAt: '2026-06-06T23:59:59Z',
      now,
    }));

    expect(result.pending).toEqual([]);
    expect(repository.calls.slice(0, 2).map((call) => call.method)).toEqual([
      'pull',
      'applyMutation',
    ]);
    expect(repository.calls[0]).toMatchObject({ cursor: undefined });
    expect(requiresFullPull('2026-06-07T00:00:00Z', now)).toBe(false);
    expect(requiresFullPull('2026-06-06T23:59:59Z', now)).toBe(true);
  });

  test('an opaque cursor follows server change order instead of row revision', async () => {
    const repository = createMemoryCloudRepository([
      { id: 'high-revision', revision: 10_000, payload: { notes: 'old' } },
    ]);
    const first = await repository.pull('u1');
    await repository.applyMutation(mutationFixture({
      mutationId: 'after-cursor',
      entityId: 'new-change',
      baseRevision: null,
    }));

    const incremental = await repository.pull('u1', first.cursor);

    expect(first.cursor).toEqual(expect.any(String));
    expect(first).not.toHaveProperty('maxRevision');
    expect(incremental.rows.map((row) => row.id)).toEqual(['new-change']);
    await expect(repository.pull('u2', first.cursor)).rejects.toMatchObject({
      code: 'owner-scope-violation',
    });
  });

  test('verifies entity, minimum revision, and tombstone state', async () => {
    const repository = createMemoryCloudRepository([
      { entity: 'calendar-entry', id: 'same', revision: 2, payload: { notes: 'live' } },
      {
        entity: 'stamp',
        id: 'same',
        revision: 4,
        payload: null,
        deletedAt: '2026-09-01T00:00:00Z',
      },
    ]);

    await expect(repository.verify('u1', [
      { entity: 'calendar-entry', entityId: 'same', minimumRevision: 2, deleted: false },
      { entity: 'stamp', entityId: 'same', minimumRevision: 4, deleted: true },
    ])).resolves.toMatchObject({ verified: true, failures: [] });
    await expect(repository.verify('u1', [
      { entity: 'calendar-entry', entityId: 'same', minimumRevision: 3, deleted: false },
      { entity: 'stamp', entityId: 'same', minimumRevision: 4, deleted: false },
    ])).resolves.toMatchObject({ verified: false, failures: expect.any(Array) });
  });

  test('never uploads another owner and keeps owner in acknowledgement keys', async () => {
    const repository = createMemoryCloudRepository([
      { ownerId: 'u1', id: 'shared-id', revision: 1, payload: { notes: 'one' } },
      { ownerId: 'u2', id: 'shared-id', revision: 1, payload: { notes: 'two' } },
    ]);
    const ownMutation = mutationFixture({
      mutationId: 'same-id',
      ownerId: 'u1',
      entityId: 'own-row',
    });
    const foreignMutation = mutationFixture({
      mutationId: 'same-id',
      ownerId: 'u2',
      entityId: 'foreign-row',
    });

    const result = await flushOutbox(
      [ownMutation, foreignMutation],
      repository,
      flushPersistence({ ownerId: 'u1' }),
    );

    expect(result.pending).toEqual([foreignMutation]);
    expect(result.acknowledgedMutations).toEqual([
      { ownerId: 'u1', mutationId: 'same-id', status: 'applied' },
    ]);
    expect(repository.rowsFor('u1').get('shared-id')?.payload).toEqual({ notes: 'one' });
    expect(repository.rowsFor('u2').get('shared-id')?.payload).toEqual({ notes: 'two' });
    expect(repository.rowsFor('u1').has('foreign-row')).toBe(false);
    expect(repository.rowsFor('u2').has('own-row')).toBe(false);
  });

  test.each([
    ['owner', (ack: MutationAcknowledgement) => ({ ...ack, ownerId: 'u2' })],
    ['entity', (ack: MutationAcknowledgement) => ({ ...ack, entity: 'stamp' as const })],
    ['id', (ack: MutationAcknowledgement) => ({ ...ack, entityId: 'wrong' })],
    ['status', (ack: MutationAcknowledgement) => ({ ...ack, status: 'unknown' as never })],
    ['revision', (ack: MutationAcknowledgement) => ({ ...ack, revision: 999 })],
    ['delete state', (ack: MutationAcknowledgement) => ({ ...ack, deleted: true })],
    ['null live payload', (ack: MutationAcknowledgement) => ({
      ...ack,
      status: 'conflict' as const,
      row: ack.row && { ...ack.row, payload: null },
    })],
    ['row owner', (ack: MutationAcknowledgement) => ({
      ...ack,
      row: ack.row && { ...ack.row, ownerId: 'u2' },
    })],
  ])('does not dequeue an acknowledgement with invalid %s', async (_label, corrupt) => {
    const mutation = mutationFixture({ mutationId: 'bad-ack' });
    const memory = createMemoryCloudRepository([]);
    const repository: CloudRepository = {
      pull: memory.pull.bind(memory),
      getMutationReceipts: memory.getMutationReceipts.bind(memory),
      applyMutation: async () => corrupt(validAppliedAcknowledgement(mutation)),
      verify: memory.verify.bind(memory),
    };
    const commitOutbox = jest.fn(async () => {});

    const result = await flushOutbox([mutation], repository, flushPersistence({ commitOutbox }));

    expect(result.pending).toEqual([{ ...mutation, attempts: 1 }]);
    expect(result.acknowledgedMutations).toEqual([]);
    expect(commitOutbox).toHaveBeenCalledWith([{ ...mutation, attempts: 1 }]);
  });

  test('accepts semantically equal JSON payloads when the server reorders object keys', async () => {
    const mutation = mutationFixture({
      mutationId: 'jsonb-order',
      payload: { z: 1, nested: { y: 2, x: 3 } },
    });
    const memory = createMemoryCloudRepository([]);
    const repository: CloudRepository = {
      pull: memory.pull.bind(memory),
      getMutationReceipts: memory.getMutationReceipts.bind(memory),
      applyMutation: async () => {
        const acknowledgement = validAppliedAcknowledgement(mutation);
        return {
          ...acknowledgement,
          row: acknowledgement.row && {
            ...acknowledgement.row,
            payload: { nested: { x: 3, y: 2 }, z: 1 },
          },
        };
      },
      verify: memory.verify.bind(memory),
    };

    const result = await flushOutbox([mutation], repository, flushPersistence());

    expect(result.pending).toEqual([]);
    expect(result.acknowledgedMutations).toEqual([
      { ownerId: 'u1', mutationId: 'jsonb-order', status: 'applied' },
    ]);
  });

  test('persists the remaining outbox after partial success', async () => {
    const memory = createMemoryCloudRepository([]);
    const originalApplyMutation = memory.applyMutation.bind(memory);
    let attempts = 0;
    memory.applyMutation = async (mutation) => {
      attempts += 1;
      if (attempts === 2) {
        throw new CloudRepositoryError('offline', 'offline', true);
      }
      return originalApplyMutation(mutation);
    };
    const first = mutationFixture({ mutationId: 'first', entityId: 'd1' });
    const second = mutationFixture({ mutationId: 'second', entityId: 'd2' });
    const third = mutationFixture({ mutationId: 'third', entityId: 'd3' });
    const commitOutbox = jest.fn(async () => {});

    const result = await flushOutbox(
      [first, second, third],
      memory,
      flushPersistence({ commitOutbox }),
    );

    expect(result.pending).toEqual([{ ...second, attempts: 1 }, third]);
    expect(commitOutbox).toHaveBeenCalledWith([{ ...second, attempts: 1 }, third]);
    expect(result.acknowledgedMutations).toEqual([
      { ownerId: 'u1', mutationId: 'first', status: 'applied' },
    ]);
  });

  test('throws on durable commit failure so an acknowledged mutation can be resent idempotently', async () => {
    const repository = createMemoryCloudRepository([]);
    const mutation = mutationFixture({ mutationId: 'commit-failed' });
    const commitFailure = new Error('disk full');

    await expect(flushOutbox([mutation], repository, flushPersistence({
      commitOutbox: async () => {
        throw commitFailure;
      },
    }))).rejects.toBe(commitFailure);

    const result = await flushOutbox([mutation], repository, flushPersistence());
    expect(repository.rows.get('d1')?.revision).toBe(1);
    expect(repository.appliedMutationIds).toEqual(['commit-failed']);
    expect(result.acknowledgedMutations).toEqual([
      { ownerId: 'u1', mutationId: 'commit-failed', status: 'applied' },
    ]);
  });

  test('requires migration persistence and a durable outbox store at compile time', () => {
    if (false) {
      // @ts-expect-error Initial migration lifecycle persistence is required.
      void runInitialMigration({ ownerId: 'u1', localRows: [], repository: createMemoryCloudRepository([]) });
      // @ts-expect-error A durable commit and conflict backup store are required.
      void flushOutbox([], createMemoryCloudRepository([]));
    }
    expect(true).toBe(true);
  });
});
