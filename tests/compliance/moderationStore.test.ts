import {
  MODERATION_REASONS,
  createModerationStore,
  type ModerationApi,
} from '../../store/moderationStore';
import type { SharedEntry } from '../../types';

function entry(userId: string): SharedEntry {
  return {
    id: `entry-${userId}`,
    groupId: 'group-1',
    userId,
    userName: userId,
    userColor: '#3B82F6',
    date: '2026-09-05',
  };
}

function apiFixture(overrides: Partial<ModerationApi> = {}): ModerationApi {
  return {
    fetchBlocks: jest.fn(async () => []),
    blockUser: jest.fn(async () => undefined),
    unblockUser: jest.fn(async () => undefined),
    reportContent: jest.fn(async () => ({ status: 'received' as const })),
    removeAndBanMember: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('moderation store', () => {
  test('blocked member entries are filtered immediately and after a refetch', async () => {
    let resolveBlock!: () => void;
    const pending = new Promise<void>((resolve) => { resolveBlock = resolve; });
    const api = apiFixture({
      blockUser: jest.fn(() => pending),
      fetchBlocks: jest.fn(async () => ['blocked-user']),
    });
    const store = createModerationStore(api);
    store.getState().setOwner('owner-a');
    store.getState().setSharedEntries([entry('blocked-user'), entry('friend')]);

    const request = store.getState().blockUser('group-1', 'blocked-user');
    expect(store.getState().getVisibleEntries().map((item) => item.userId)).toEqual(['friend']);
    resolveBlock();
    await request;
    await store.getState().fetchBlocks();
    expect(store.getState().getVisibleEntries().map((item) => item.userId)).toEqual(['friend']);
  });

  test('rolls optimistic blocking back if the server rejects it', async () => {
    const api = apiFixture({ blockUser: jest.fn(async () => { throw new Error('denied'); }) });
    const store = createModerationStore(api);
    store.getState().setOwner('owner-a');
    store.getState().setSharedEntries([entry('member-2')]);

    await expect(store.getState().blockUser('group-1', 'member-2')).rejects.toThrow('denied');
    expect(store.getState().getVisibleEntries()).toHaveLength(1);
    expect(store.getState().error).toBeTruthy();
  });

  test('a failed block rollback does not discard another successful block', async () => {
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const api = apiFixture({
      blockUser: jest.fn((_ownerId, _groupId, userId) =>
        userId === 'member-1' ? first : Promise.resolve()
      ),
    });
    const store = createModerationStore(api);
    store.getState().setOwner('owner-a');

    const firstRequest = store.getState().blockUser('group-1', 'member-1');
    const firstFailure = expect(firstRequest).rejects.toThrow('denied');
    await store.getState().blockUser('group-1', 'member-2');
    rejectFirst(new Error('denied'));
    await firstFailure;

    expect(store.getState().blockedUserIds).toEqual(['member-2']);
  });

  test('submits only an allowed reason with a trimmed bounded detail', async () => {
    const api = apiFixture();
    const store = createModerationStore(api);
    store.getState().setOwner('owner-a');

    await store.getState().reportContent({
      groupId: 'group-1',
      targetUserId: 'member-2',
      sharedEntryId: 'entry-member-2',
      reason: 'spam_fraud',
      detail: '  Repeated invite links  ',
    });

    expect(api.reportContent).toHaveBeenCalledWith(
      'owner-a',
      expect.objectContaining({ reason: 'spam_fraud', detail: 'Repeated invite links' })
    );
    expect(store.getState().lastReportStatus).toBe('received');
    expect(MODERATION_REASONS).toContain('harassment');
  });

  test('rejects an overlong report without sending it', async () => {
    const api = apiFixture();
    const store = createModerationStore(api);
    store.getState().setOwner('owner-a');

    await expect(
      store.getState().reportContent({
        groupId: 'group-1',
        targetUserId: 'member-2',
        reason: 'other',
        detail: 'x'.repeat(501),
      })
    ).rejects.toThrow(/500/);
    expect(api.reportContent).not.toHaveBeenCalled();
  });

  test('keeps the report target busy until the server returns', async () => {
    let resolve!: () => void;
    const pending = new Promise<{ status: 'received' }>((done) => {
      resolve = () => done({ status: 'received' });
    });
    const api = apiFixture({ reportContent: jest.fn(() => pending) });
    const store = createModerationStore(api);
    store.getState().setOwner('owner-a');

    const request = store.getState().reportContent({
      groupId: 'group-1',
      targetUserId: 'member-2',
      reason: 'other',
      detail: '',
    });
    expect(store.getState().busyUserIds).toContain('member-2');
    resolve();
    await request;
    expect(store.getState().busyUserIds).not.toContain('member-2');
  });

  test('an old owner fetch cannot repopulate moderation data after an account switch', async () => {
    let resolveOwnerA!: (ids: string[]) => void;
    const ownerA = new Promise<string[]>((resolve) => { resolveOwnerA = resolve; });
    const api = apiFixture({
      fetchBlocks: jest.fn((ownerId: string) =>
        ownerId === 'owner-a' ? ownerA : Promise.resolve(['blocked-by-b'])
      ),
    });
    const store = createModerationStore(api);

    store.getState().setOwner('owner-a');
    const staleFetch = store.getState().fetchBlocks();
    store.getState().setOwner('owner-b');
    await store.getState().fetchBlocks();
    resolveOwnerA(['blocked-by-a']);
    await staleFetch;

    expect(store.getState().ownerId).toBe('owner-b');
    expect(store.getState().blockedUserIds).toEqual(['blocked-by-b']);
    expect(api.fetchBlocks).toHaveBeenCalledWith('owner-a');
    expect(api.fetchBlocks).toHaveBeenCalledWith('owner-b');
  });

  test('clears all visible moderation state synchronously when the owner changes', () => {
    const store = createModerationStore(apiFixture());
    store.getState().setOwner('owner-a');
    store.getState().setSharedEntries([entry('member-a')]);
    store.setState({ blockedUserIds: ['member-a'], lastReportStatus: 'received' });

    store.getState().setOwner('owner-b');

    expect(store.getState()).toMatchObject({
      ownerId: 'owner-b',
      blockedUserIds: [],
      sharedEntries: [],
      busyUserIds: [],
      error: null,
      lastReportStatus: null,
    });
  });

  test('refuses remote moderation actions until an authenticated owner is bound', async () => {
    const api = apiFixture();
    const store = createModerationStore(api);

    await expect(store.getState().fetchBlocks()).rejects.toThrow(/認証/);
    await expect(store.getState().blockUser('group-1', 'member-2')).rejects.toThrow(/認証/);
    expect(api.fetchBlocks).not.toHaveBeenCalled();
    expect(api.blockUser).not.toHaveBeenCalled();
  });
});
