import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSupabaseClient, requireSupabaseClient } from '../lib/supabase';
import { devError } from '../utils/devLog';
import { Group, GroupMember, GroupSharingSettings, SharedEntry, SyncEntryData, TimeSlot } from '../types';
import { useAppSessionStore } from './appSessionStore';
import { assertSharedPayloadAllowed } from '../lib/moderation/contentFilter';

const MEMBER_COLORS = ['#FF6B9D', '#A78BFA', '#34D399', '#60A5FA', '#FBBF24', '#FB923C'];

/** egress 削減: 必要な列だけ取得 */
const GROUPS_SELECT = 'id,name,color,emoji,invite_code,shared_memo,created_at';
const GROUP_MEMBERS_SELECT = 'group_id,user_id,user_name,color,is_owner';
const SHARED_ENTRIES_SELECT =
  'id,group_id,user_id,user_name,user_color,date,main_stamp_text,main_stamp_bg,main_stamp_text_color,mini_left_text,mini_left_bg,mini_right_text,mini_right_bg,notes,time_slots';

/** 共有スケジュール取得の日付範囲（全件取得を避ける。カレンダーを大きく動かしても通常は十分な幅） */
function sharedEntryFetchDateBounds(): { min: string; max: string } {
  const y = new Date().getFullYear();
  const pad = 45;
  return { min: `${y - pad}-01-01`, max: `${y + pad}-12-31` };
}

/** 短時間に fetchGroups が重複起動しないよう間引く（手動更新は force で必ず実行） */
let lastFetchGroupsAt = 0;
const FETCH_GROUPS_COOLDOWN_MS = 30_000;
const SHARED_TIME_SLOT_LIMIT = 96;
const SHARED_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function randomColor(): string {
  return MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)];
}

function isConnectivityError(detail?: string) {
  return Boolean(detail && /fetch|network|offline|timeout|timed out|connection/i.test(detail));
}

function recoverableGroupCloudError(action: string, detail?: string) {
  const message =
    `${action}に失敗しました。` +
    '個人の予定はそのまま利用できます。接続を確認して再度お試しください。' +
    (detail ? ` (${detail})` : '');
  if (isConnectivityError(detail)) {
    useAppSessionStore.getState().setCloudOffline(message);
  } else {
    useAppSessionStore.getState().setCloudError(message);
  }
  return new Error(message);
}

function markGroupCloudOnline() {
  useAppSessionStore.getState().setCloudOnline?.();
}

function safeSharedUrl(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      || parsed.username
      || parsed.password
    ) return null;
    return value;
  } catch {
    return null;
  }
}

/** Treat shared rows as untrusted even when they came through RLS. */
export function parseSharedTimeSlots(value: unknown): TimeSlot[] | undefined {
  let decoded = value;
  if (typeof value === 'string') {
    if (!value || value.length > 65_536) return undefined;
    try {
      decoded = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(decoded) || decoded.length > SHARED_TIME_SLOT_LIMIT) return undefined;

  const result: TimeSlot[] = [];
  for (const candidate of decoded) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
    const slot = candidate as Record<string, unknown>;
    if (
      typeof slot.id !== 'string'
      || slot.id.length < 1
      || slot.id.length > 200
      || typeof slot.startTime !== 'string'
      || !SHARED_TIME_PATTERN.test(slot.startTime)
      || typeof slot.endTime !== 'string'
      || !SHARED_TIME_PATTERN.test(slot.endTime)
      || typeof slot.title !== 'string'
      || slot.title.length > 500
      || typeof slot.color !== 'string'
      || slot.color.length < 1
      || slot.color.length > 32
      || (slot.notificationEnabled !== undefined && typeof slot.notificationEnabled !== 'boolean')
      || (slot.reflectToMonthly !== undefined && typeof slot.reflectToMonthly !== 'boolean')
    ) return undefined;
    const url = safeSharedUrl(slot.url);
    if (url === null) return undefined;
    result.push({
      id: slot.id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      title: slot.title,
      color: slot.color,
      ...(url ? { url } : {}),
      ...(typeof slot.notificationEnabled === 'boolean'
        ? { notificationEnabled: slot.notificationEnabled }
        : {}),
      ...(typeof slot.reflectToMonthly === 'boolean'
        ? { reflectToMonthly: slot.reflectToMonthly }
        : {}),
    });
  }
  return result;
}

function buildSharedEntryRow(
  groupId: string,
  myUserId: string,
  syncDisplayName: string,
  myColor: string,
  e: SyncEntryData
) {
  const timeSlots = parseSharedTimeSlots(e.timeSlots);
  return {
    group_id: groupId,
    user_id: myUserId,
    user_name: syncDisplayName,
    user_color: myColor,
    date: e.date,
    main_stamp_text: e.mainStampText ?? null,
    main_stamp_bg: e.mainStampBg ?? null,
    main_stamp_text_color: e.mainStampTextColor ?? null,
    mini_left_text: e.miniLeftText ?? null,
    mini_left_bg: e.miniLeftBg ?? null,
    mini_right_text: e.miniRightText ?? null,
    mini_right_bg: e.miniRightBg ?? null,
    notes: e.notes ?? null,
    time_slots: timeSlots && timeSlots.length > 0 ? JSON.stringify(timeSlots) : null,
  };
}

export function mapSharedEntryRow(row: any): SharedEntry {
  const timeSlots = parseSharedTimeSlots(row.time_slots);
  return {
    id: row.id,
    groupId: row.group_id,
    userId: row.user_id,
    userName: row.user_name,
    userColor: row.user_color,
    date: row.date,
    mainStampText: row.main_stamp_text ?? undefined,
    mainStampBg: row.main_stamp_bg ?? undefined,
    mainStampTextColor: row.main_stamp_text_color ?? undefined,
    miniLeftText: row.mini_left_text ?? undefined,
    miniLeftBg: row.mini_left_bg ?? undefined,
    miniRightText: row.mini_right_text ?? undefined,
    miniRightBg: row.mini_right_bg ?? undefined,
    notes: row.notes ?? undefined,
    timeSlots,
  };
}

function sharedEntryContentEqual(dbRow: any, insertShape: ReturnType<typeof buildSharedEntryRow>): boolean {
  const ts =
    typeof dbRow.time_slots === 'string'
      ? dbRow.time_slots
      : dbRow.time_slots != null
        ? JSON.stringify(dbRow.time_slots)
        : null;
  const wantTs = insertShape.time_slots;
  return (
    dbRow.user_name === insertShape.user_name &&
    dbRow.user_color === insertShape.user_color &&
    dbRow.main_stamp_text === insertShape.main_stamp_text &&
    dbRow.main_stamp_bg === insertShape.main_stamp_bg &&
    dbRow.main_stamp_text_color === insertShape.main_stamp_text_color &&
    dbRow.mini_left_text === insertShape.mini_left_text &&
    dbRow.mini_left_bg === insertShape.mini_left_bg &&
    dbRow.mini_right_text === insertShape.mini_right_text &&
    dbRow.mini_right_bg === insertShape.mini_right_bg &&
    dbRow.notes === insertShape.notes &&
    (ts || null) === (wantTs || null)
  );
}

function rowToGroup(g: any, allMembers: any[]): Group {
  const members: GroupMember[] = allMembers
    .filter((m) => m.group_id === g.id)
    .map((m) => ({ id: m.user_id, name: m.user_name, color: m.color, isOwner: m.is_owner }));
  return {
    id: g.id,
    name: g.name,
    color: g.color,
    emoji: g.emoji,
    inviteCode: g.invite_code,
    sharedMemo: g.shared_memo ?? '',
    members,
    createdAt: g.created_at,
  };
}

const DEFAULT_SHARING: GroupSharingSettings = { shareMain: true, shareMini: false, shareNotes: false, shareTimeSchedule: false };

/** RPC create_group_with_owner / join_group_by_invite の戻り（groups 行） */
interface GroupsDbRow {
  id: string;
  name: string;
  color: string;
  emoji: string;
  invite_code: string;
  shared_memo: string | null;
  created_at: string;
}

interface GroupState {
  groups: Group[];
  /** 永続化した groups がどの Auth ユーザーに属するか（別ユーザーになったら一覧を捨てる） */
  cachedUserId: string;
  myUserId: string;
  myName: string;
  loading: boolean;
  sharingSettings: Record<string, GroupSharingSettings>;
  sharedEntries: Record<string, SharedEntry[]>;
  groupIconUris: Record<string, string | undefined>;
  /** Runtime-only generations. They are intentionally excluded from persisted state. */
  authGeneration: number;
  dataMutationGeneration: number;
  fetchGroupsRequestGeneration: number;
  scheduleRequestGenerations: Record<string, number>;
  /** Supabase Auth の user.id。cachedUserId と突き合わせる。 */
  setAuthUserId: (userId: string | null) => void;
  setMyName: (name: string) => void;
  setSharingSettings: (groupId: string, settings: GroupSharingSettings) => void;
  createGroup: (name: string, color: string, emoji: string) => Promise<Group | null>;
  joinGroupByCode: (inviteCode: string) => Promise<Group | null>;
  fetchGroups: (options?: { force?: boolean }) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  updateSharedMemo: (groupId: string, memo: string) => Promise<void>;
  updateGroupName: (groupId: string, name: string) => Promise<void>;
  setGroupIconUri: (groupId: string, uri?: string) => void;
  syncMySchedule: (groupId: string, entries: SyncEntryData[]) => Promise<void>;
  fetchGroupSchedules: (groupId: string) => Promise<void>;
}

interface GroupOperationOwner {
  userId: string;
  authGeneration: number;
}

export class StaleGroupOperationError extends Error {
  constructor() {
    super('認証状態が変更されたため、開始中のグループ操作を中止しました。');
    this.name = 'StaleGroupOperationError';
  }
}

const memoUpdateQueues = new Map<string, Promise<void>>();
const nameUpdateQueues = new Map<string, Promise<void>>();

function enqueueGroupUpdate(
  queues: Map<string, Promise<void>>,
  groupId: string,
  operation: () => Promise<void>
): Promise<void> {
  const previous = queues.get(groupId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  queues.set(groupId, settled);
  void settled.then(() => {
    if (queues.get(groupId) === settled) queues.delete(groupId);
  });
  return result;
}

/** Keep writes for the same group ordered even when the initiating sheet unmounts. */
export function enqueueGroupMemoUpdate(
  groupId: string,
  operation: () => Promise<void>
) {
  return enqueueGroupUpdate(memoUpdateQueues, groupId, operation);
}

function enqueueGroupNameUpdate(groupId: string, operation: () => Promise<void>) {
  return enqueueGroupUpdate(nameUpdateQueues, groupId, operation);
}

function operationOwnerIsCurrent(state: GroupState, owner: GroupOperationOwner) {
  return state.myUserId === owner.userId && state.authGeneration === owner.authGeneration;
}

function assertOperationOwner(get: () => GroupState, owner: GroupOperationOwner) {
  if (!operationOwnerIsCurrent(get(), owner)) throw new StaleGroupOperationError();
}

async function captureGroupOperation(get: () => GroupState) {
  const { client, userId } = await requireGroupSession();
  let state = get();
  if (!state.myUserId) {
    state.setAuthUserId(userId);
    state = get();
  }
  if (state.myUserId !== userId) throw new StaleGroupOperationError();
  return {
    client,
    owner: { userId, authGeneration: state.authGeneration } satisfies GroupOperationOwner,
  };
}

async function requireGroupSession() {
  const userId = await useAppSessionStore.getState().ensureGuestSession('group-action');
  if (!userId) {
    throw new Error('グループ機能の認証を確認できませんでした。もう一度お試しください。');
  }
  return { client: requireSupabaseClient(), userId };
}

export const useGroupStore = create<GroupState>()(
  persist(
    (set, get) => ({
      groups: [],
      cachedUserId: '',
      myUserId: '',
      myName: 'わたし',
      loading: false,
      sharingSettings: {},
      sharedEntries: {},
      groupIconUris: {},
      authGeneration: 0,
      dataMutationGeneration: 0,
      fetchGroupsRequestGeneration: 0,
      scheduleRequestGenerations: {},

      setMyName: (name) => set({ myName: name }),

      setAuthUserId: (userId) =>
        set((state) => {
          const id = userId ?? '';
          const hasSharedCache =
            state.groups.length > 0
            || Object.keys(state.sharingSettings).length > 0
            || Object.keys(state.sharedEntries).length > 0
            || Object.keys(state.groupIconUris).length > 0;
          if (
            state.myUserId === id
            && state.cachedUserId === id
            && (id !== '' || !hasSharedCache)
          ) return state;
          const generationState = {
            authGeneration: state.authGeneration + 1,
            dataMutationGeneration: state.dataMutationGeneration + 1,
            fetchGroupsRequestGeneration: state.fetchGroupsRequestGeneration + 1,
            scheduleRequestGenerations: {},
            loading: false,
          };
          if (!id) {
            return {
              ...generationState,
              myUserId: '',
              cachedUserId: '',
              myName: 'わたし',
              groups: [],
              sharingSettings: {},
              sharedEntries: {},
              groupIconUris: {},
            };
          }
          const switchingActiveOwner = Boolean(state.myUserId && state.myUserId !== id);
          const cacheBelongsToAnotherOwner = Boolean(
            state.cachedUserId && state.cachedUserId !== id
          );
          const unownedSensitiveCache = !state.cachedUserId && hasSharedCache;
          if (switchingActiveOwner || cacheBelongsToAnotherOwner || unownedSensitiveCache) {
            return {
              ...generationState,
              myUserId: id,
              cachedUserId: id,
              myName: 'わたし',
              groups: [],
              sharingSettings: {},
              sharedEntries: {},
              groupIconUris: {},
            };
          }
          return { ...generationState, myUserId: id, cachedUserId: id };
        }),

      setSharingSettings: (groupId, settings) =>
        set((state) => ({
          sharingSettings: { ...state.sharingSettings, [groupId]: settings },
        })),

      setGroupIconUri: (groupId, uri) =>
        set((state) => ({
          groupIconUris: { ...state.groupIconUris, [groupId]: uri },
          groups: state.groups.map((g) => (g.id === groupId ? { ...g, iconUri: uri } : g)),
        })),

      createGroup: async (name, color, emoji) => {
        assertSharedPayloadAllowed({ groupName: name, userName: get().myName });
        set((state) => ({
          dataMutationGeneration: state.dataMutationGeneration + 1,
          loading: false,
        }));
        const { client, owner } = await captureGroupOperation(get);
        const myUserId = owner.userId;
        const { myName } = get();

        const { data: raw, error: rpcErr } = await client
          .rpc('create_group_with_owner', {
            p_name: name,
            p_color: color,
            p_emoji: emoji,
            p_user_name: myName,
          })
          .single();

        assertOperationOwner(get, owner);
        if (rpcErr || !raw) {
          devError('createGroup rpc', rpcErr?.message ?? undefined);
          if (rpcErr?.message?.includes('group_limit_reached')) {
            throw new Error(rpcErr.message);
          }
          throw recoverableGroupCloudError('グループの作成', rpcErr?.message);
        }
        const groupData = raw as GroupsDbRow;

        const group: Group = {
          id: groupData.id,
          name: groupData.name,
          color: groupData.color,
          emoji: groupData.emoji,
          iconUri: get().groupIconUris[groupData.id],
          inviteCode: groupData.invite_code,
          sharedMemo: groupData.shared_memo ?? '',
          members: [{ id: myUserId, name: myName, color, isOwner: true }],
          createdAt: groupData.created_at,
        };

        set((state) => {
          if (!operationOwnerIsCurrent(state, owner)) return state;
          return {
            groups: [...state.groups, group],
            cachedUserId: myUserId,
            dataMutationGeneration: state.dataMutationGeneration + 1,
          };
        });
        assertOperationOwner(get, owner);
        markGroupCloudOnline();
        return group;
      },

      joinGroupByCode: async (inviteCode) => {
        assertSharedPayloadAllowed({ userName: get().myName });
        set((state) => ({
          dataMutationGeneration: state.dataMutationGeneration + 1,
          loading: false,
        }));
        const { client, owner } = await captureGroupOperation(get);
        const myUserId = owner.userId;
        const { myName } = get();

        const code = inviteCode.trim().toUpperCase();
        const color = randomColor();

        const { data: raw, error: rpcErr } = await client
          .rpc('join_group_by_invite', {
            p_invite: code,
            p_user_name: myName,
            p_color: color,
          })
          .maybeSingle();

        assertOperationOwner(get, owner);
        if (rpcErr) {
          devError('joinGroup rpc', rpcErr.message);
          throw recoverableGroupCloudError('グループへの参加', rpcErr.message);
        }
        if (!raw) {
          markGroupCloudOnline();
          return null;
        }

        const groupData = raw as GroupsDbRow;

        const { data: membersData, error: membersError } = await client
          .from('group_members')
          .select(GROUP_MEMBERS_SELECT)
          .eq('group_id', groupData.id);

        assertOperationOwner(get, owner);
        if (membersError) {
          devError('joinGroup members', membersError.message);
          throw recoverableGroupCloudError('グループ情報の取得', membersError.message);
        }
        const group = rowToGroup(groupData, membersData ?? []);

        set((state) => {
          if (!operationOwnerIsCurrent(state, owner)) return state;
          const already = state.groups.find((g) => g.id === group.id);
          const nextGroups = already
            ? state.groups.map((g) => (g.id === group.id ? group : g))
            : [...state.groups, group];
          return {
            groups: nextGroups,
            cachedUserId: myUserId,
            dataMutationGeneration: state.dataMutationGeneration + 1,
          };
        });

        assertOperationOwner(get, owner);
        markGroupCloudOnline();
        return group;
      },

      fetchGroups: async (options?: { force?: boolean }) => {
        let { myUserId } = get();
        if (!myUserId && !options?.force) {
          set({ loading: false });
          return;
        }
        if (
          !options?.force &&
          get().groups.length > 0 &&
          Date.now() - lastFetchGroupsAt < FETCH_GROUPS_COOLDOWN_MS
        ) {
          return;
        }

        let client = getSupabaseClient();
        if (!myUserId) {
          try {
            const operation = await captureGroupOperation(get);
            client = operation.client;
            myUserId = operation.owner.userId;
          } catch (error) {
            set({ loading: false });
            throw error;
          }
        } else if (!client) {
          set({ loading: false });
          if (options?.force) requireSupabaseClient();
          return;
        }

        const owner: GroupOperationOwner = {
          userId: myUserId,
          authGeneration: get().authGeneration,
        };
        let requestGeneration = 0;
        let mutationGeneration = 0;
        set((state) => {
          requestGeneration = state.fetchGroupsRequestGeneration + 1;
          mutationGeneration = state.dataMutationGeneration;
          return { loading: true, fetchGroupsRequestGeneration: requestGeneration };
        });
        const isCurrentFetch = () => {
          const state = get();
          return (
            operationOwnerIsCurrent(state, owner) &&
            state.fetchGroupsRequestGeneration === requestGeneration &&
            state.dataMutationGeneration === mutationGeneration
          );
        };

        const { data: myMemberships, error: memErr } = await client
          .from('group_members')
          .select('group_id')
          .eq('user_id', myUserId);

        if (!isCurrentFetch()) return;
        if (memErr) {
          devError('fetchGroups group_members', memErr.message);
          set({ loading: false });
          const error = recoverableGroupCloudError('グループ一覧の更新', memErr.message);
          if (options?.force) throw error;
          return;
        }

        if (!myMemberships || myMemberships.length === 0) {
          if (!isCurrentFetch()) return;
          lastFetchGroupsAt = Date.now();
          markGroupCloudOnline();
          set({ loading: false, groups: [], cachedUserId: myUserId });
          return;
        }

        const groupIds = myMemberships.map((m: any) => m.group_id);

        const [{ data: groupsData, error: gErr }, { data: allMembers, error: mErr }] = await Promise.all([
          client.from('groups').select(GROUPS_SELECT).in('id', groupIds),
          client.from('group_members').select(GROUP_MEMBERS_SELECT).in('group_id', groupIds),
        ]);

        if (!isCurrentFetch()) return;
        if (gErr || mErr) {
          devError('fetchGroups', gErr?.message ?? mErr?.message);
          set({ loading: false });
          const error = recoverableGroupCloudError(
            'グループ一覧の更新',
            gErr?.message ?? mErr?.message
          );
          if (options?.force) throw error;
          return;
        }

        if (!groupsData) {
          markGroupCloudOnline();
          set({ loading: false });
          return;
        }

        lastFetchGroupsAt = Date.now();
        const iconMap = get().groupIconUris;
        const groups = groupsData.map((g) => {
          const group = rowToGroup(g, allMembers ?? []);
          return { ...group, iconUri: iconMap[group.id] };
        });
        if (!isCurrentFetch()) return;
        markGroupCloudOnline();
        set({ groups, loading: false, cachedUserId: myUserId });
      },

      deleteGroup: async (groupId) => {
        set((state) => ({
          dataMutationGeneration: state.dataMutationGeneration + 1,
          loading: false,
        }));
        const { client, owner } = await captureGroupOperation(get);
        const { error } = await client.rpc('leave_group', { p_group_id: groupId });
        assertOperationOwner(get, owner);
        if (error) {
          devError('deleteGroup leave_group', error.message);
          throw recoverableGroupCloudError('グループからの退出', error.message);
        }

        set((state) => {
          if (!operationOwnerIsCurrent(state, owner)) return state;
          return {
            groups: state.groups.filter((g) => g.id !== groupId),
            cachedUserId: owner.userId,
            sharedEntries: { ...state.sharedEntries, [groupId]: [] },
            dataMutationGeneration: state.dataMutationGeneration + 1,
          };
        });
        assertOperationOwner(get, owner);
        markGroupCloudOnline();
      },

      updateSharedMemo: (groupId, memo) => {
        try {
          assertSharedPayloadAllowed({ sharedMemo: memo });
        } catch (error) {
          return Promise.reject(error);
        }
        const requestedOwner: GroupOperationOwner = {
          userId: get().myUserId,
          authGeneration: get().authGeneration,
        };
        set((state) => ({
          dataMutationGeneration: state.dataMutationGeneration + 1,
          loading: false,
        }));

        return enqueueGroupMemoUpdate(groupId, async () => {
          if (requestedOwner.userId) assertOperationOwner(get, requestedOwner);
          const { client, owner } = await captureGroupOperation(get);
          if (
            requestedOwner.userId &&
            (requestedOwner.userId !== owner.userId ||
              requestedOwner.authGeneration !== owner.authGeneration)
          ) {
            throw new StaleGroupOperationError();
          }

          const { data: updated, error } = await client
            .rpc('update_group_memo', { p_group_id: groupId, p_memo: memo })
            .single();
          assertOperationOwner(get, owner);
          if (error || !updated) {
            const detail = error?.message ?? '更新対象を確認できませんでした';
            devError('updateSharedMemo', detail);
            throw recoverableGroupCloudError('共有メモの更新', detail);
          }
          const confirmedMemo = (updated as { shared_memo?: string | null }).shared_memo ?? '';
          set((state) => {
            if (!operationOwnerIsCurrent(state, owner)) return state;
            return {
              groups: state.groups.map((g) =>
                g.id === groupId ? { ...g, sharedMemo: confirmedMemo } : g
              ),
              dataMutationGeneration: state.dataMutationGeneration + 1,
            };
          });
          assertOperationOwner(get, owner);
          markGroupCloudOnline();
        });
      },

      updateGroupName: (groupId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return Promise.resolve();
        try {
          assertSharedPayloadAllowed({ groupName: trimmed });
        } catch (error) {
          return Promise.reject(error);
        }
        const requestedOwner: GroupOperationOwner = {
          userId: get().myUserId,
          authGeneration: get().authGeneration,
        };
        set((state) => ({
          dataMutationGeneration: state.dataMutationGeneration + 1,
          loading: false,
        }));

        return enqueueGroupNameUpdate(groupId, async () => {
          if (requestedOwner.userId) assertOperationOwner(get, requestedOwner);
          const { client, owner } = await captureGroupOperation(get);
          if (
            requestedOwner.userId &&
            (requestedOwner.userId !== owner.userId ||
              requestedOwner.authGeneration !== owner.authGeneration)
          ) {
            throw new StaleGroupOperationError();
          }
          const { data: updated, error } = await client
            .rpc('rename_group', { p_group_id: groupId, p_name: trimmed })
            .single();
          assertOperationOwner(get, owner);
          if (error || !updated) {
            const detail = error?.message ?? '更新対象を確認できませんでした';
            devError('updateGroupName', detail);
            throw recoverableGroupCloudError('グループ名の更新', detail);
          }
          const confirmedName = (updated as { name: string }).name;
          set((state) => {
            if (!operationOwnerIsCurrent(state, owner)) return state;
            return {
              groups: state.groups.map((g) =>
                g.id === groupId ? { ...g, name: confirmedName } : g
              ),
              dataMutationGeneration: state.dataMutationGeneration + 1,
            };
          });
          assertOperationOwner(get, owner);
          markGroupCloudOnline();
        });
      },

      syncMySchedule: async (groupId, entries) => {
        assertSharedPayloadAllowed(entries);
        const { client, owner } = await captureGroupOperation(get);
        const myUserId = owner.userId;
        const { myName, groups } = get();
        const myMember = groups.find((g) => g.id === groupId)?.members.find((m) => m.id === myUserId);
        const myColor = myMember?.color ?? '#A78BFA';
        const syncDisplayName = (myMember?.name ?? myName).trim() || myName;

        if (entries.length === 0) {
          const { error } = await client
            .from('shared_entries')
            .delete()
            .eq('group_id', groupId)
            .eq('user_id', myUserId);
          assertOperationOwner(get, owner);
          if (error) throw recoverableGroupCloudError('共有予定の更新', error.message);
          markGroupCloudOnline();
          return;
        }

        const { data: existing, error: selErr } = await client
          .from('shared_entries')
          .select(SHARED_ENTRIES_SELECT)
          .eq('group_id', groupId)
          .eq('user_id', myUserId);

        assertOperationOwner(get, owner);
        if (selErr) throw recoverableGroupCloudError('共有予定の取得', selErr.message);

        const byDate = new Map<string, any>();
        for (const r of existing ?? []) {
          byDate.set(r.date, r);
        }

        const newByDate = new Map<string, ReturnType<typeof buildSharedEntryRow>>();
        for (const e of entries) {
          newByDate.set(e.date, buildSharedEntryRow(groupId, myUserId, syncDisplayName, myColor, e));
        }

        const toDeleteIds: string[] = [];
        for (const [d, row] of byDate) {
          if (!newByDate.has(d)) toDeleteIds.push(row.id);
        }

        const toInsert: ReturnType<typeof buildSharedEntryRow>[] = [];
        const toUpdate: { id: string; patch: Record<string, unknown> }[] = [];

        for (const [date, patch] of newByDate) {
          const old = byDate.get(date);
          if (!old) {
            toInsert.push(patch);
            continue;
          }
          if (sharedEntryContentEqual(old, patch)) continue;
          toUpdate.push({
            id: old.id,
            patch: {
              user_name: patch.user_name,
              user_color: patch.user_color,
              main_stamp_text: patch.main_stamp_text,
              main_stamp_bg: patch.main_stamp_bg,
              main_stamp_text_color: patch.main_stamp_text_color,
              mini_left_text: patch.mini_left_text,
              mini_left_bg: patch.mini_left_bg,
              mini_right_text: patch.mini_right_text,
              mini_right_bg: patch.mini_right_bg,
              notes: patch.notes,
              time_slots: patch.time_slots,
            },
          });
        }

        if (toDeleteIds.length > 0) {
          const { error: delErr } = await client.from('shared_entries').delete().in('id', toDeleteIds);
          assertOperationOwner(get, owner);
          if (delErr) throw recoverableGroupCloudError('共有予定の更新', delErr.message);
        }

        if (toInsert.length > 0) {
          const { error: insertErr } = await client.from('shared_entries').insert(toInsert);
          assertOperationOwner(get, owner);
          if (insertErr) {
            if (insertErr.message?.includes('time_slots')) {
              const rowsWithoutTs = toInsert.map(({ time_slots, ...rest }) => rest);
              const { error: retryErr } = await client.from('shared_entries').insert(rowsWithoutTs);
              assertOperationOwner(get, owner);
              if (retryErr) {
                throw recoverableGroupCloudError('共有予定の更新', retryErr.message);
              }
            } else {
              throw recoverableGroupCloudError('共有予定の更新', insertErr.message);
            }
          }
        }

        const runUpdate = async (id: string, patch: Record<string, unknown>) => {
          const { error: uErr } = await client.from('shared_entries').update(patch).eq('id', id);
          assertOperationOwner(get, owner);
          if (uErr) {
            if (uErr.message?.includes('time_slots')) {
              const { time_slots: _ts, ...rest } = patch;
              const { error: r2 } = await client.from('shared_entries').update(rest).eq('id', id);
              assertOperationOwner(get, owner);
              if (r2) throw recoverableGroupCloudError('共有予定の更新', r2.message);
            } else {
              throw recoverableGroupCloudError('共有予定の更新', uErr.message);
            }
          }
        };

        const chunk = 16;
        for (let i = 0; i < toUpdate.length; i += chunk) {
          assertOperationOwner(get, owner);
          const slice = toUpdate.slice(i, i + chunk);
          await Promise.all(slice.map(({ id, patch }) => runUpdate(id, patch)));
        }
        assertOperationOwner(get, owner);
        markGroupCloudOnline();
      },

      fetchGroupSchedules: async (groupId) => {
        const { client, owner } = await captureGroupOperation(get);
        let requestGeneration = 0;
        let mutationGeneration = 0;
        set((state) => {
          requestGeneration = (state.scheduleRequestGenerations[groupId] ?? 0) + 1;
          mutationGeneration = state.dataMutationGeneration;
          return {
            scheduleRequestGenerations: {
              ...state.scheduleRequestGenerations,
              [groupId]: requestGeneration,
            },
          };
        });
        const isCurrentScheduleFetch = () => {
          const state = get();
          return (
            operationOwnerIsCurrent(state, owner) &&
            state.scheduleRequestGenerations[groupId] === requestGeneration &&
            state.dataMutationGeneration === mutationGeneration
          );
        };
        const { min, max } = sharedEntryFetchDateBounds();
        const { data, error } = await client
          .from('shared_entries')
          .select(SHARED_ENTRIES_SELECT)
          .eq('group_id', groupId)
          .gte('date', min)
          .lte('date', max)
          .order('date', { ascending: true });

        assertOperationOwner(get, owner);
        if (!isCurrentScheduleFetch()) return;
        if (error) {
          devError('fetchGroupSchedules', error.message);
          throw recoverableGroupCloudError('共有予定の取得', error.message);
        }

        const entries: SharedEntry[] = (data ?? []).map(mapSharedEntryRow);

        set((state) => {
          if (
            !operationOwnerIsCurrent(state, owner) ||
            state.scheduleRequestGenerations[groupId] !== requestGeneration ||
            state.dataMutationGeneration !== mutationGeneration
          ) {
            return state;
          }
          return { sharedEntries: { ...state.sharedEntries, [groupId]: entries } };
        });
        assertOperationOwner(get, owner);
        if (isCurrentScheduleFetch()) markGroupCloudOnline();
      },
    }),
    {
      name: 'group-storage-v2',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        groups: state.groups,
        cachedUserId: state.cachedUserId,
        myName: state.myName,
        sharingSettings: state.sharingSettings,
        groupIconUris: state.groupIconUris,
      }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<GroupState>;
        const merged = { ...currentState, ...persisted, myUserId: currentState.myUserId };

        // Auth 復元が AsyncStorage 復元より先に完了しても、別ユーザーの cache を復活させない。
        if (currentState.myUserId && persisted.cachedUserId !== currentState.myUserId) {
          return {
            ...merged,
            groups: [],
            cachedUserId: currentState.myUserId,
            myName: 'わたし',
            loading: false,
            sharingSettings: {},
            sharedEntries: {},
            groupIconUris: {},
          };
        }

        return merged;
      },
    }
  )
);
