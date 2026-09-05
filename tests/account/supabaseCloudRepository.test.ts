import {
  CloudRepositoryError,
  createSupabaseCloudRepository,
  type SupabaseCloudClient,
} from '../../lib/account/supabaseCloudRepository';
import { mutationFixture } from './fixtures';

type Row = Record<string, unknown>;

function createQuery(data: Row[]) {
  const calls: unknown[][] = [];
  let rows = [...data];

  const query = {
    select(columns: string) {
      calls.push(['select', columns]);
      return query;
    },
    eq(column: string, value: unknown) {
      calls.push(['eq', column, value]);
      rows = rows.filter((row) => row[column] === value);
      return query;
    },
    gt(column: string, value: unknown) {
      calls.push(['gt', column, value]);
      rows = rows.filter((row) => Number(row[column]) > Number(value));
      return query;
    },
    in(column: string, values: readonly unknown[]) {
      calls.push(['in', column, [...values]]);
      rows = rows.filter((row) => values.includes(row[column]));
      return query;
    },
    order(column: string, options?: Record<string, unknown>) {
      calls.push(['order', column, options]);
      rows.sort((left, right) => Number(left[column]) - Number(right[column]));
      return query;
    },
    range(from: number, to: number) {
      calls.push(['range', from, to]);
      const page = rows.slice(from, to + 1);
      return Promise.resolve({ data: page, error: null });
    },
  };

  return { query, calls };
}

function createClientFixture({
  userId = 'u1',
  tables = {},
  rpcData = [],
}: {
  userId?: string | null;
  tables?: Record<string, Row[]>;
  rpcData?: unknown | ((name: string, input: Record<string, unknown>) => unknown);
} = {}) {
  const calls: unknown[][] = [];
  const queries = new Map<string, ReturnType<typeof createQuery>>();
  const client: SupabaseCloudClient = {
    auth: {
      async getUser() {
        calls.push(['getUser']);
        return {
          data: { user: userId ? { id: userId, is_anonymous: false } : null },
          error: null,
        };
      },
    },
    from(table: string) {
      calls.push(['from', table]);
      const fixture = createQuery(tables[table] ?? []);
      queries.set(table, fixture);
      return fixture.query;
    },
    async rpc(name: string, input: Record<string, unknown>) {
      calls.push(['rpc', name, input]);
      return {
        data: typeof rpcData === 'function' ? rpcData(name, input) : rpcData,
        error: null,
      };
    },
  };
  return { client, calls, queries };
}

describe('Supabase personal cloud repository', () => {
  test('maps all personal tables and keeps the incremental cursor owner-scoped', async () => {
    const rows = [
      {
        ownerId: 'u1', entity: 'calendar-entry', id: '2026-09-05',
        payload: { notes: 'remote' }, revision: 3,
        updatedAt: '2026-09-05T01:00:00Z', deletedAt: null, changeSequence: 7,
        schemaVersion: 1,
      },
      {
        ownerId: 'u1', entity: 'special-date', id: 'birthday-1', payload: null,
        revision: 4, updatedAt: '2026-09-05T02:00:00Z',
        deletedAt: '2026-09-05T02:00:00Z', changeSequence: 9,
      },
      {
        ownerId: 'u1', entity: 'preference', id: 'preferences',
        payload: { weekStartDay: 1 }, revision: 2,
        updatedAt: '2026-09-05T00:00:00Z', deletedAt: null, changeSequence: 5,
      },
      {
        ownerId: 'u1', entity: 'stamp', id: 'stamp-1',
        payload: { text: 'flight' }, revision: 1,
        updatedAt: '2026-09-05T00:30:00Z', deletedAt: null, changeSequence: 6,
      },
      {
        ownerId: 'u1', entity: 'trip', id: 'trip-1',
        payload: { title: 'Tokyo' }, revision: 2,
        updatedAt: '2026-09-05T01:30:00Z', deletedAt: null, changeSequence: 8,
      },
      {
        ownerId: 'u1', entity: 'trip-item', id: 'trip-item-1',
        payload: { tripId: 'trip-1', type: 'flight' }, revision: 1,
        updatedAt: '2026-09-05T01:45:00Z', deletedAt: null, changeSequence: 9,
      },
    ];
    const fixture = createClientFixture({
      rpcData: (_name: string, input: Record<string, unknown>) =>
        Number(input.p_after_change_sequence ?? 0) === 0
        ? { rows, cursor: '9' }
        : { rows: [], cursor: '9' },
    });
    const repository = createSupabaseCloudRepository(fixture.client);

    const first = await repository.pull('u1');

    expect(first.rows).toEqual([
      expect.objectContaining({ entity: 'preference', id: 'preferences', revision: 2 }),
      expect.objectContaining({ entity: 'stamp', id: 'stamp-1', revision: 1 }),
      expect.objectContaining({
        entity: 'calendar-entry', id: '2026-09-05', revision: 3, schemaVersion: 1,
      }),
      expect.objectContaining({ entity: 'trip', id: 'trip-1', revision: 2 }),
      expect.objectContaining({ entity: 'trip-item', id: 'trip-item-1', revision: 1 }),
      expect.objectContaining({
        entity: 'special-date', id: 'birthday-1', revision: 4,
        deletedAt: '2026-09-05T02:00:00Z',
      }),
    ]);
    expect(first.cursor).toMatch(/^recoto-cloud-v1:/);

    await repository.pull('u1', first.cursor);
    expect(fixture.calls).toContainEqual([
      'rpc', 'pull_personal_changes', { p_after_change_sequence: null },
    ]);
    expect(fixture.calls).toContainEqual([
      'rpc', 'pull_personal_changes', { p_after_change_sequence: 9 },
    ]);
  });

  test('refuses cross-owner access before querying personal rows', async () => {
    const fixture = createClientFixture({ userId: 'u1' });
    const repository = createSupabaseCloudRepository(fixture.client);

    await expect(repository.pull('u2')).rejects.toMatchObject<Partial<CloudRepositoryError>>({
      code: 'owner-scope-violation',
      retryable: false,
    });
    expect(fixture.calls.some(([name]) => name === 'from')).toBe(false);
  });

  test('quarantines a future-version row as non-retryable before publishing it', async () => {
    const fixture = createClientFixture({
      rpcData: {
        rows: [{
          ownerId: 'u1', entity: 'calendar-entry', id: 'future',
          payload: { notes: 'from a newer app' }, revision: 3,
          updatedAt: '2026-09-05T01:00:00Z', deletedAt: null,
          schemaVersion: 2,
        }],
        cursor: '7',
      },
    });

    await expect(createSupabaseCloudRepository(fixture.client).pull('u1'))
      .rejects.toMatchObject<Partial<CloudRepositoryError>>({
        code: 'unsupported-schema-version',
        retryable: false,
      });
  });

  test('sends one CAS mutation through the atomic RPC and validates its receipt', async () => {
    const mutation = mutationFixture({
      mutationId: 'm1',
      entity: 'trip-item',
      entityId: 'trip-item-1',
      payload: { id: 'trip-item-1', tripId: 'trip-1', type: 'flight' },
      baseRevision: 4,
    });
    const fixture = createClientFixture({
      rpcData: [{
        mutationId: 'm1', ownerId: 'u1', entity: 'trip-item', entityId: 'trip-item-1',
        status: 'applied', revision: 5, deleted: false, schemaVersion: 1,
        row: {
          ownerId: 'u1', entity: 'trip-item', id: 'trip-item-1', revision: 5,
          payload: { id: 'trip-item-1', tripId: 'trip-1', type: 'flight' },
          updatedAt: '2026-09-05T00:00:00Z', schemaVersion: 1,
        },
      }],
    });
    const repository = createSupabaseCloudRepository(fixture.client);

    await expect(repository.applyMutation(mutation)).resolves.toMatchObject({
      mutationId: 'm1', status: 'applied', revision: 5, schemaVersion: 1,
    });
    expect(mutation.schemaVersion).toBe(1);
    expect(fixture.calls).toContainEqual(['rpc', 'apply_personal_mutations', {
      p_mutations: [mutation],
    }]);
  });

  test('recovers durable mutation receipts and rejects malformed acknowledgements', async () => {
    const validAck = {
      mutationId: 'm1', ownerId: 'u1', entity: 'stamp', entityId: 's1',
      status: 'conflict', revision: null, deleted: false, row: null, schemaVersion: 1,
    };
    const fixture = createClientFixture({
      tables: { sync_mutations: [{ user_id: 'u1', mutation_id: 'm1', ack: validAck }] },
    });
    const repository = createSupabaseCloudRepository(fixture.client);

    await expect(repository.getMutationReceipts('u1', ['m1', 'm1'])).resolves.toEqual([validAck]);

    const malformed = createClientFixture({ rpcData: [{ mutationId: 'wrong' }] });
    await expect(
      createSupabaseCloudRepository(malformed.client).applyMutation(mutationFixture({ mutationId: 'm1' })),
    ).rejects.toMatchObject<Partial<CloudRepositoryError>>({ code: 'ack-mismatch' });
  });

  test('verifies revision and deletion state against the authoritative remote rows', async () => {
    const fixture = createClientFixture({
      rpcData: {
        rows: [{
          ownerId: 'u1', entity: 'calendar-entry', id: 'd1',
          payload: { notes: 'remote' }, revision: 3,
          updatedAt: '2026-09-05T01:00:00Z', deletedAt: null, changeSequence: 7,
        }],
        cursor: '7',
      },
    });
    const repository = createSupabaseCloudRepository(fixture.client);

    await expect(repository.verify('u1', [
      { entity: 'calendar-entry', entityId: 'd1', minimumRevision: 4, deleted: false },
      { entity: 'stamp', entityId: 'missing', minimumRevision: 1, deleted: false },
    ])).resolves.toEqual({
      verified: false,
      failures: [
        expect.objectContaining({ reason: 'revision-too-old' }),
        expect.objectContaining({ reason: 'missing' }),
      ],
    });
  });
});
