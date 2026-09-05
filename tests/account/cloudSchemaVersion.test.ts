jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import {
  CloudRepositoryError,
  createMemoryCloudRepository,
  type CloudRow,
} from '../../lib/account/cloudRepository';
import { snapshotFromCloudRows, snapshotToCloudRows } from '../../lib/account/accountBootstrapPersistence';
import { flushOutbox, runInitialMigration } from '../../lib/account/syncEngine';
import type { OutboxMutation } from '../../types/account';
import { emptyPersonalSnapshot, mutationFixture } from './fixtures';

const now = '2026-09-05T00:00:00.000Z';

const row = (schemaVersion: number): CloudRow => ({
  ownerId: 'u1',
  entity: 'calendar-entry',
  id: '2026-09-05',
  revision: 1,
  payload: {
    date: '2026-09-05',
    miniStamps: {},
    privacyLevel: 2,
  },
  updatedAt: now,
  schemaVersion,
} as CloudRow);

describe('personal cloud schema version', () => {
  test('preserves version 1 through seed, memory pull, mutation, and acknowledgement', async () => {
    const repository = createMemoryCloudRepository([row(1)]);
    const pulled = await repository.pull('u1');
    expect(pulled.rows[0].schemaVersion).toBe(1);

    const mutation = mutationFixture({
      mutationId: 'schema-roundtrip',
      entityId: '2026-09-06',
      schemaVersion: 1,
    } as Partial<OutboxMutation>);
    const acknowledgement = await repository.applyMutation(mutation);
    expect(acknowledgement.schemaVersion).toBe(1);
    expect(acknowledgement.row?.schemaVersion).toBe(1);
  });

  test('defaults legacy versionless v1 rows while emitting current version seeds', () => {
    const legacy: Omit<CloudRow, 'schemaVersion'> & { schemaVersion?: number } = { ...row(1) };
    delete legacy.schemaVersion;
    expect(snapshotFromCloudRows([legacy as CloudRow]).entries['2026-09-05']).toBeDefined();

    const seeds = snapshotToCloudRows(
      { kind: 'user', id: 'u1' },
      emptyPersonalSnapshot(),
      [],
      now,
    );
    expect(seeds).not.toHaveLength(0);
    expect(seeds.every((seed) => seed.schemaVersion === 1)).toBe(true);
  });

  test('quarantines future remote rows before initial migration can publish them', async () => {
    const repository = createMemoryCloudRepository([row(2)]);
    const markMigrationComplete = jest.fn();

    await expect(runInitialMigration({
      ownerId: 'u1',
      localRows: [],
      repository,
      waitForHydration: async () => undefined,
      persistLocalBackup: async () => undefined,
      markMigrationComplete,
    })).rejects.toMatchObject<Partial<CloudRepositoryError>>({
      code: 'unsupported-schema-version',
      retryable: false,
    });
    expect(markMigrationComplete).not.toHaveBeenCalled();
  });

  test('keeps a future-version mutation quarantined and never sends it', async () => {
    const repository = createMemoryCloudRepository([]);
    const mutation = mutationFixture({
      mutationId: 'future-schema',
      schemaVersion: 2,
    } as Partial<OutboxMutation>);
    const commits: OutboxMutation[][] = [];

    const result = await flushOutbox([mutation], repository, {
      ownerId: 'u1',
      commitOutbox: async (pending) => { commits.push([...pending]); },
      persistConflictBackups: async () => undefined,
    });

    expect(result).toMatchObject({ syncPhase: 'error', retryDelayMs: null });
    expect(result.pending).toEqual([expect.objectContaining({
      mutationId: 'future-schema',
      schemaVersion: 2,
    })]);
    expect(repository.appliedMutationIds).toEqual([]);
    expect(commits.at(-1)?.[0]).toEqual(expect.objectContaining({ schemaVersion: 2 }));
  });

  test('refuses to derive outbound rows from a future-version baseline', () => {
    expect(() => snapshotToCloudRows(
      { kind: 'user', id: 'u1' },
      emptyPersonalSnapshot(),
      [row(2)],
      now,
    )).toThrow(expect.objectContaining({
      code: 'unsupported-schema-version',
      retryable: false,
    }));
  });
});
