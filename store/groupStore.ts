import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { Group, GroupMember, GroupSharingSettings, SharedEntry, SyncEntryData } from '../types';

const MEMBER_COLORS = ['#FF6B9D', '#A78BFA', '#34D399', '#60A5FA', '#FBBF24', '#FB923C'];

function generateUserId(): string {
  return `user_${Math.random().toString(36).substring(2, 14)}`;
}

function generateInviteCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function randomColor(): string {
  return MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)];
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

const DEFAULT_SHARING: GroupSharingSettings = { shareMain: true, shareMini: false, shareNotes: false };

interface GroupState {
  groups: Group[];
  myUserId: string;
  myName: string;
  loading: boolean;
  sharingSettings: Record<string, GroupSharingSettings>;
  sharedEntries: Record<string, SharedEntry[]>;
  setMyName: (name: string) => void;
  setSharingSettings: (groupId: string, settings: GroupSharingSettings) => void;
  createGroup: (name: string, color: string, emoji: string) => Promise<Group | null>;
  joinGroupByCode: (inviteCode: string) => Promise<Group | null>;
  fetchGroups: () => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  updateSharedMemo: (groupId: string, memo: string) => Promise<void>;
  syncMySchedule: (groupId: string, entries: SyncEntryData[]) => Promise<void>;
  fetchGroupSchedules: (groupId: string) => Promise<void>;
}

export const useGroupStore = create<GroupState>()(
  persist(
    (set, get) => ({
      groups: [],
      myUserId: generateUserId(),
      myName: 'わたし',
      loading: false,
      sharingSettings: {},
      sharedEntries: {},

      setMyName: (name) => set({ myName: name }),

      setSharingSettings: (groupId, settings) =>
        set((state) => ({
          sharingSettings: { ...state.sharingSettings, [groupId]: settings },
        })),

      createGroup: async (name, color, emoji) => {
        const { myUserId, myName } = get();
        const inviteCode = generateInviteCode();

        const { data: groupData, error: groupErr } = await supabase
          .from('groups')
          .insert({ name, color, emoji, invite_code: inviteCode, shared_memo: '' })
          .select()
          .single();

        if (groupErr || !groupData) {
          console.error('createGroup error:', JSON.stringify(groupErr));
          throw new Error(groupErr?.message ?? 'グループ作成失敗');
        }

        const { error: memberErr } = await supabase
          .from('group_members')
          .insert({ group_id: groupData.id, user_id: myUserId, user_name: myName, color, is_owner: true });

        if (memberErr) {
          console.error('addMember error:', JSON.stringify(memberErr));
          throw new Error(memberErr?.message ?? 'メンバー追加失敗');
        }

        const group: Group = {
          id: groupData.id,
          name: groupData.name,
          color: groupData.color,
          emoji: groupData.emoji,
          inviteCode: groupData.invite_code,
          sharedMemo: groupData.shared_memo ?? '',
          members: [{ id: myUserId, name: myName, color, isOwner: true }],
          createdAt: groupData.created_at,
        };

        set((state) => ({ groups: [...state.groups, group] }));
        return group;
      },

      joinGroupByCode: async (inviteCode) => {
        const { myUserId, myName } = get();
        const code = inviteCode.trim().toUpperCase();

        const { data: groupData, error: groupErr } = await supabase
          .from('groups')
          .select('*')
          .eq('invite_code', code)
          .single();

        if (groupErr || !groupData) {
          console.error('joinGroup: group not found', groupErr);
          return null;
        }

        const { data: existing } = await supabase
          .from('group_members')
          .select('id')
          .eq('group_id', groupData.id)
          .eq('user_id', myUserId)
          .maybeSingle();

        if (!existing) {
          const color = randomColor();
          await supabase.from('group_members').insert({
            group_id: groupData.id,
            user_id: myUserId,
            user_name: myName,
            color,
            is_owner: false,
          });
        }

        const { data: membersData } = await supabase
          .from('group_members')
          .select('*')
          .eq('group_id', groupData.id);

        const group = rowToGroup(groupData, membersData ?? []);

        set((state) => {
          const already = state.groups.find((g) => g.id === group.id);
          if (already) {
            return { groups: state.groups.map((g) => (g.id === group.id ? group : g)) };
          }
          return { groups: [...state.groups, group] };
        });

        return group;
      },

      fetchGroups: async () => {
        const { myUserId } = get();
        set({ loading: true });

        const { data: myMemberships } = await supabase
          .from('group_members')
          .select('group_id')
          .eq('user_id', myUserId);

        if (!myMemberships || myMemberships.length === 0) {
          set({ loading: false, groups: [] });
          return;
        }

        const groupIds = myMemberships.map((m: any) => m.group_id);

        const [{ data: groupsData }, { data: allMembers }] = await Promise.all([
          supabase.from('groups').select('*').in('id', groupIds),
          supabase.from('group_members').select('*').in('group_id', groupIds),
        ]);

        if (!groupsData) {
          set({ loading: false });
          return;
        }

        const groups = groupsData.map((g) => rowToGroup(g, allMembers ?? []));
        set({ groups, loading: false });
      },

      deleteGroup: async (groupId) => {
        const { myUserId } = get();

        await supabase
          .from('group_members')
          .delete()
          .eq('group_id', groupId)
          .eq('user_id', myUserId);

        const { data: remaining } = await supabase
          .from('group_members')
          .select('id')
          .eq('group_id', groupId);

        if (!remaining || remaining.length === 0) {
          await supabase.from('groups').delete().eq('id', groupId);
        }

        set((state) => ({ groups: state.groups.filter((g) => g.id !== groupId) }));
      },

      updateSharedMemo: async (groupId, memo) => {
        await supabase.from('groups').update({ shared_memo: memo }).eq('id', groupId);
        set((state) => ({
          groups: state.groups.map((g) => (g.id === groupId ? { ...g, sharedMemo: memo } : g)),
        }));
      },

      syncMySchedule: async (groupId, entries) => {
        const { myUserId, myName, groups } = get();
        const myMember = groups.find((g) => g.id === groupId)?.members.find((m) => m.id === myUserId);
        const myColor = myMember?.color ?? '#A78BFA';

        // 既存データを削除してから再挿入
        await supabase
          .from('shared_entries')
          .delete()
          .eq('group_id', groupId)
          .eq('user_id', myUserId);

        if (entries.length === 0) return;

        const rows = entries.map((e) => ({
          group_id: groupId,
          user_id: myUserId,
          user_name: myName,
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
        }));

        await supabase.from('shared_entries').insert(rows);
      },

      fetchGroupSchedules: async (groupId) => {
        const { data } = await supabase
          .from('shared_entries')
          .select('*')
          .eq('group_id', groupId)
          .order('date', { ascending: true });

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
        }));

        set((state) => ({
          sharedEntries: { ...state.sharedEntries, [groupId]: entries },
        }));
      },
    }),
    {
      name: 'group-storage',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        myUserId: state.myUserId,
        myName: state.myName,
        sharingSettings: state.sharingSettings,
      }),
    }
  )
);
