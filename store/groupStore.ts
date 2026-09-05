import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { devError } from '../utils/devLog';
import { Group, GroupMember, GroupSharingSettings, SharedEntry, SyncEntryData } from '../types';

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

function randomColor(): string {
  return MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)];
}

function buildSharedEntryRow(
  groupId: string,
  myUserId: string,
  syncDisplayName: string,
  myColor: string,
  e: SyncEntryData
) {
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
    time_slots: e.timeSlots && e.timeSlots.length > 0 ? JSON.stringify(e.timeSlots) : null,
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

      setMyName: (name) => set({ myName: name }),

      setAuthUserId: (userId) =>
        set((state) => {
          const id = userId ?? '';
          if (!id) {
            return { myUserId: '' };
          }
          if (state.cachedUserId && state.cachedUserId !== id) {
            return {
              myUserId: id,
              cachedUserId: id,
              groups: [],
              sharedEntries: {},
            };
          }
          return { myUserId: id, cachedUserId: id };
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
        const { myUserId, myName } = get();
        if (!myUserId) throw new Error('認証の準備ができていません。しばらく待ってから再度お試しください。');

        const { data: raw, error: rpcErr } = await supabase
          .rpc('create_group_with_owner', {
            p_name: name,
            p_color: color,
            p_emoji: emoji,
            p_user_name: myName,
          })
          .single();

        if (rpcErr || !raw) {
          devError('createGroup rpc', rpcErr?.message ?? undefined);
          throw new Error(rpcErr?.message ?? 'グループ作成失敗');
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

        set((state) => ({
          groups: [...state.groups, group],
          cachedUserId: myUserId,
        }));
        return group;
      },

      joinGroupByCode: async (inviteCode) => {
        const { myUserId, myName } = get();
        if (!myUserId) throw new Error('認証の準備ができていません。しばらく待ってから再度お試しください。');

        const code = inviteCode.trim().toUpperCase();
        const color = randomColor();

        const { data: raw, error: rpcErr } = await supabase
          .rpc('join_group_by_invite', {
            p_invite: code,
            p_user_name: myName,
            p_color: color,
          })
          .maybeSingle();

        if (rpcErr) {
          devError('joinGroup rpc', rpcErr.message);
          throw new Error(rpcErr.message);
        }
        if (!raw) {
          return null;
        }

        const groupData = raw as GroupsDbRow;

        const { data: membersData } = await supabase
          .from('group_members')
          .select(GROUP_MEMBERS_SELECT)
          .eq('group_id', groupData.id);

        const group = rowToGroup(groupData, membersData ?? []);

        set((state) => {
          const already = state.groups.find((g) => g.id === group.id);
          const nextGroups = already
            ? state.groups.map((g) => (g.id === group.id ? group : g))
            : [...state.groups, group];
          return { groups: nextGroups, cachedUserId: myUserId };
        });

        return group;
      },

      fetchGroups: async (options?: { force?: boolean }) => {
        const { myUserId } = get();
        if (!myUserId) {
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
        set({ loading: true });

        const { data: myMemberships, error: memErr } = await supabase
          .from('group_members')
          .select('group_id')
          .eq('user_id', myUserId);

        if (memErr) {
          devError('fetchGroups group_members', memErr.message);
          set({ loading: false });
          return;
        }

        if (!myMemberships || myMemberships.length === 0) {
          lastFetchGroupsAt = Date.now();
          set({ loading: false, groups: [], cachedUserId: myUserId });
          return;
        }

        const groupIds = myMemberships.map((m: any) => m.group_id);

        const [{ data: groupsData, error: gErr }, { data: allMembers, error: mErr }] = await Promise.all([
          supabase.from('groups').select(GROUPS_SELECT).in('id', groupIds),
          supabase.from('group_members').select(GROUP_MEMBERS_SELECT).in('group_id', groupIds),
        ]);

        if (gErr || mErr) {
          devError('fetchGroups', gErr?.message ?? mErr?.message);
          set({ loading: false });
          return;
        }

        if (!groupsData) {
          set({ loading: false });
          return;
        }

        lastFetchGroupsAt = Date.now();
        const iconMap = get().groupIconUris;
        const groups = groupsData.map((g) => {
          const group = rowToGroup(g, allMembers ?? []);
          return { ...group, iconUri: iconMap[group.id] };
        });
        set({ groups, loading: false, cachedUserId: myUserId });
      },

      deleteGroup: async (groupId) => {
        const { myUserId } = get();
        if (!myUserId) throw new Error('認証されていません');

        // 先に自分の共有行を消す（FK や RLS で group_members だけ消せないことがある）
        const { error: seErr } = await supabase
          .from('shared_entries')
          .delete()
          .eq('group_id', groupId)
          .eq('user_id', myUserId);
        if (seErr) {
          devError('deleteGroup shared_entries', seErr.message);
          throw new Error(seErr.message);
        }

        const { error: gmErr } = await supabase
          .from('group_members')
          .delete()
          .eq('group_id', groupId)
          .eq('user_id', myUserId);
        if (gmErr) {
          devError('deleteGroup group_members', gmErr.message);
          throw new Error(gmErr.message);
        }

        const { data: remaining, error: remErr } = await supabase
          .from('group_members')
          .select('id')
          .eq('group_id', groupId);
        if (remErr) {
          devError('deleteGroup count members', remErr.message);
        } else if (!remaining || remaining.length === 0) {
          const { error: gErr } = await supabase.from('groups').delete().eq('id', groupId);
          if (gErr) devError('deleteGroup groups', gErr.message);
        }

        set((state) => ({
          groups: state.groups.filter((g) => g.id !== groupId),
          cachedUserId: myUserId,
          sharedEntries: { ...state.sharedEntries, [groupId]: [] },
        }));
      },

      updateSharedMemo: async (groupId, memo) => {
        await supabase.from('groups').update({ shared_memo: memo }).eq('id', groupId);
        set((state) => ({
          groups: state.groups.map((g) => (g.id === groupId ? { ...g, sharedMemo: memo } : g)),
        }));
      },

      updateGroupName: async (groupId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        await supabase.from('groups').update({ name: trimmed }).eq('id', groupId);
        set((state) => ({
          groups: state.groups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g)),
        }));
      },

      syncMySchedule: async (groupId, entries) => {
        const { myUserId, myName, groups } = get();
        if (!myUserId) throw new Error('認証の準備ができていません。');
        const myMember = groups.find((g) => g.id === groupId)?.members.find((m) => m.id === myUserId);
        const myColor = myMember?.color ?? '#A78BFA';
        const syncDisplayName = (myMember?.name ?? myName).trim() || myName;

        if (entries.length === 0) {
          await supabase.from('shared_entries').delete().eq('group_id', groupId).eq('user_id', myUserId);
          return;
        }

        const { data: existing, error: selErr } = await supabase
          .from('shared_entries')
          .select(SHARED_ENTRIES_SELECT)
          .eq('group_id', groupId)
          .eq('user_id', myUserId);

        if (selErr) throw new Error(selErr.message);

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
          const { error: delErr } = await supabase.from('shared_entries').delete().in('id', toDeleteIds);
          if (delErr) throw new Error(delErr.message);
        }

        if (toInsert.length > 0) {
          const { error: insertErr } = await supabase.from('shared_entries').insert(toInsert);
          if (insertErr) {
            if (insertErr.message?.includes('time_slots')) {
              const rowsWithoutTs = toInsert.map(({ time_slots, ...rest }) => rest);
              const { error: retryErr } = await supabase.from('shared_entries').insert(rowsWithoutTs);
              if (retryErr) throw new Error(retryErr.message);
            } else {
              throw new Error(insertErr.message);
            }
          }
        }

        const runUpdate = async (id: string, patch: Record<string, unknown>) => {
          const { error: uErr } = await supabase.from('shared_entries').update(patch).eq('id', id);
          if (uErr) {
            if (uErr.message?.includes('time_slots')) {
              const { time_slots: _ts, ...rest } = patch;
              const { error: r2 } = await supabase.from('shared_entries').update(rest).eq('id', id);
              if (r2) throw new Error(r2.message);
            } else throw new Error(uErr.message);
          }
        };

        const chunk = 16;
        for (let i = 0; i < toUpdate.length; i += chunk) {
          const slice = toUpdate.slice(i, i + chunk);
          await Promise.all(slice.map(({ id, patch }) => runUpdate(id, patch)));
        }
      },

      fetchGroupSchedules: async (groupId) => {
        const { min, max } = sharedEntryFetchDateBounds();
        const { data, error } = await supabase
          .from('shared_entries')
          .select(SHARED_ENTRIES_SELECT)
          .eq('group_id', groupId)
          .gte('date', min)
          .lte('date', max)
          .order('date', { ascending: true });

        if (error) {
          devError('fetchGroupSchedules', error.message);
          throw new Error(error.message);
        }

        const entries: SharedEntry[] = (data ?? []).map((row: any) => ({
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
          timeSlots: row.time_slots ? (() => { try { return JSON.parse(row.time_slots); } catch { return undefined; } })() : undefined,
        }));

        set((state) => ({
          sharedEntries: { ...state.sharedEntries, [groupId]: entries },
        }));
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
    }
  )
);
