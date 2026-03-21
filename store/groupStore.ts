import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Group, GroupMember } from '../types';

interface GroupState {
  groups: Group[];
  myUserId: string;
  myName: string;
  setMyName: (name: string) => void;
  addGroup: (group: Group) => void;
  removeGroup: (id: string) => void;
  updateGroup: (id: string, updates: Partial<Group>) => void;
  updateMemo: (groupId: string, memo: string) => void;
  addMember: (groupId: string, member: GroupMember) => void;
  removeMember: (groupId: string, memberId: string) => void;
}

function generateInviteCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const MY_USER_ID = `user_${Math.random().toString(36).substring(2, 10)}`;

export const useGroupStore = create<GroupState>()(
  persist(
    (set) => ({
      groups: [],
      myUserId: MY_USER_ID,
      myName: 'わたし',

      setMyName: (name) => set({ myName: name }),

      addGroup: (group) =>
        set((state) => ({ groups: [...state.groups, group] })),

      removeGroup: (id) =>
        set((state) => ({
          groups: state.groups.filter((g) => g.id !== id),
        })),

      updateGroup: (id, updates) =>
        set((state) => ({
          groups: state.groups.map((g) =>
            g.id === id ? { ...g, ...updates } : g
          ),
        })),

      updateMemo: (groupId, memo) =>
        set((state) => ({
          groups: state.groups.map((g) =>
            g.id === groupId ? { ...g, sharedMemo: memo } : g
          ),
        })),

      addMember: (groupId, member) =>
        set((state) => ({
          groups: state.groups.map((g) =>
            g.id === groupId
              ? { ...g, members: [...g.members, member] }
              : g
          ),
        })),

      removeMember: (groupId, memberId) =>
        set((state) => ({
          groups: state.groups.map((g) =>
            g.id === groupId
              ? { ...g, members: g.members.filter((m) => m.id !== memberId) }
              : g
          ),
        })),
    }),
    {
      name: 'group-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
