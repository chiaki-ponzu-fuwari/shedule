jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

const group = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Friends',
  color: '#3B82F6',
  emoji: '👥',
  inviteCode: 'ABC123',
  sharedMemo: '',
  members: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Me',
      color: '#3B82F6',
      isOwner: true,
    },
  ],
  createdAt: '2026-09-05T00:00:00.000Z',
};

function loadStore(client: object) {
  jest.resetModules();
  const session = {
    ensureGuestSession: jest.fn(async () => '22222222-2222-4222-8222-222222222222'),
    setCloudOffline: jest.fn(),
    setCloudError: jest.fn(),
    setCloudOnline: jest.fn(),
  };
  jest.doMock('../../lib/supabase', () => ({
    getSupabaseClient: () => client,
    requireSupabaseClient: () => client,
  }));
  jest.doMock('../../store/appSessionStore', () => ({
    useAppSessionStore: { getState: () => session },
  }));
  const module = require('../../store/groupStore') as typeof import('../../store/groupStore');
  module.useGroupStore.getState().setAuthUserId('22222222-2222-4222-8222-222222222222');
  module.useGroupStore.setState({ groups: [group], cachedUserId: '22222222-2222-4222-8222-222222222222' });
  return module;
}

describe('group moderation integration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('../../lib/supabase');
    jest.dontMock('../../store/appSessionStore');
    jest.resetModules();
  });

  test('rejects unsafe shared memo before any remote write', async () => {
    const client = { rpc: jest.fn() };
    const { useGroupStore } = loadStore(client);

    await expect(
      useGroupStore.getState().updateSharedMemo(group.id, 'j​avascript:alert(1)')
    ).rejects.toMatchObject({ name: 'UnsafeSharedContentError' });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  test('uses narrow RPCs for shared group writes and leaving', async () => {
    const rpc = jest.fn((name: string) => {
      if (name === 'update_group_memo') {
        return { single: jest.fn(async () => ({ data: { id: group.id, shared_memo: 'Safe memo' }, error: null })) };
      }
      if (name === 'rename_group') {
        return { single: jest.fn(async () => ({ data: { id: group.id, name: 'New name' }, error: null })) };
      }
      return Promise.resolve({ data: null, error: null });
    });
    const { useGroupStore } = loadStore({ rpc });

    await useGroupStore.getState().updateSharedMemo(group.id, 'Safe memo');
    await useGroupStore.getState().updateGroupName(group.id, 'New name');
    await useGroupStore.getState().deleteGroup(group.id);

    expect(rpc).toHaveBeenCalledWith('update_group_memo', { p_group_id: group.id, p_memo: 'Safe memo' });
    expect(rpc).toHaveBeenCalledWith('rename_group', { p_group_id: group.id, p_name: 'New name' });
    expect(rpc).toHaveBeenCalledWith('leave_group', { p_group_id: group.id });
  });

  test('preserves stable identifiers needed to report a shared entry', () => {
    const { mapSharedEntryRow } = loadStore({});
    const mapped = mapSharedEntryRow({
      id: '33333333-3333-4333-8333-333333333333',
      group_id: group.id,
      user_id: '44444444-4444-4444-8444-444444444444',
      user_name: 'Member',
      user_color: '#EF4444',
      date: '2026-09-05',
      notes: 'Lunch',
      time_slots: null,
    });

    expect(mapped).toMatchObject({
      id: '33333333-3333-4333-8333-333333333333',
      groupId: group.id,
      userId: '44444444-4444-4444-8444-444444444444',
    });
  });

  test('drops malformed shared time slots instead of exposing crashable server data', () => {
    const { mapSharedEntryRow } = loadStore({});
    const base = {
      id: '33333333-3333-4333-8333-333333333333',
      group_id: group.id,
      user_id: '44444444-4444-4444-8444-444444444444',
      user_name: 'Member',
      user_color: '#EF4444',
      date: '2026-09-05',
    };

    expect(mapSharedEntryRow({ ...base, time_slots: '{}' }).timeSlots).toBeUndefined();
    expect(mapSharedEntryRow({ ...base, time_slots: '[{"id":"x"}]' }).timeSlots).toBeUndefined();
    expect(mapSharedEntryRow({
      ...base,
      time_slots: JSON.stringify([{
        id: 'slot-1',
        startTime: '09:00',
        endTime: '10:00',
        title: 'Meeting',
        color: '#3B82F6',
        url: 'javascript:alert(1)',
      }]),
    }).timeSlots).toBeUndefined();
  });

  test('accepts only bounded portable time-slot fields from shared rows', () => {
    const { mapSharedEntryRow } = loadStore({});
    const mapped = mapSharedEntryRow({
      id: '33333333-3333-4333-8333-333333333333',
      group_id: group.id,
      user_id: '44444444-4444-4444-8444-444444444444',
      user_name: 'Member',
      user_color: '#EF4444',
      date: '2026-09-05',
      time_slots: JSON.stringify([{
        id: 'slot-1',
        startTime: '09:00',
        endTime: '10:00',
        title: 'Meeting',
        color: '#3B82F6',
        url: 'https://example.com/room',
        notificationEnabled: true,
        notificationId: 'device-secret',
        reflectToMonthly: true,
      }]),
    });

    expect(mapped.timeSlots).toEqual([{
      id: 'slot-1',
      startTime: '09:00',
      endTime: '10:00',
      title: 'Meeting',
      color: '#3B82F6',
      url: 'https://example.com/room',
      notificationEnabled: true,
      reflectToMonthly: true,
    }]);
    expect(JSON.stringify(mapped.timeSlots)).not.toContain('device-secret');
  });
});
