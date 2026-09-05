import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SharedEntry } from '../types';

export const MODERATION_REASONS = [
  'harassment',
  'hate',
  'sexual',
  'violence',
  'personal_info',
  'spam_fraud',
  'copyright',
  'other',
] as const;

export type ModerationReason = (typeof MODERATION_REASONS)[number];

export interface ModerationReportInput {
  groupId: string;
  targetUserId: string;
  sharedEntryId?: string;
  reason: ModerationReason;
  detail: string;
  clientReportId?: string;
}

export interface ModerationReportResult {
  status: 'received';
  reportId?: string;
}

export interface ModerationApi {
  fetchBlocks(ownerId: string): Promise<string[]>;
  blockUser(ownerId: string, groupId: string, targetUserId: string): Promise<void>;
  unblockUser(ownerId: string, targetUserId: string): Promise<void>;
  reportContent(ownerId: string, input: ModerationReportInput): Promise<ModerationReportResult>;
  removeAndBanMember(ownerId: string, groupId: string, targetUserId: string): Promise<void>;
}

export interface ModerationState {
  ownerId: string | null;
  ownerGeneration: number;
  blockedUserIds: string[];
  sharedEntries: SharedEntry[];
  busyUserIds: string[];
  error: string | null;
  lastReportStatus: 'received' | null;
  blockGenerations: Record<string, number>;
  fetchGeneration: number;
  setOwner(ownerId: string | null): void;
  setSharedEntries(entries: SharedEntry[]): void;
  getVisibleEntries(): SharedEntry[];
  isBlocked(userId: string): boolean;
  clear(): void;
  fetchBlocks(): Promise<void>;
  blockUser(groupId: string, targetUserId: string): Promise<void>;
  unblockUser(targetUserId: string): Promise<void>;
  reportContent(input: Omit<ModerationReportInput, 'clientReportId'>): Promise<void>;
  removeAndBanMember(groupId: string, targetUserId: string): Promise<void>;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作を完了できませんでした。';
}

function requireBoundOwner(state: ModerationState) {
  if (!state.ownerId) throw new Error('グループの認証を確認できませんでした。');
  return { ownerId: state.ownerId, ownerGeneration: state.ownerGeneration };
}

function buildModerationState(
  api: ModerationApi,
  set: StoreApi<ModerationState>['setState'],
  get: StoreApi<ModerationState>['getState']
): ModerationState {
  return {
    ownerId: null,
    ownerGeneration: 0,
    blockedUserIds: [],
    sharedEntries: [],
    busyUserIds: [],
    error: null,
    lastReportStatus: null,
    blockGenerations: {},
    fetchGeneration: 0,

    setOwner: (ownerId) => set((state) => {
      if (state.ownerId === ownerId) return state;
      return {
        ownerId,
        ownerGeneration: state.ownerGeneration + 1,
        blockedUserIds: [],
        sharedEntries: [],
        busyUserIds: [],
        error: null,
        lastReportStatus: null,
        blockGenerations: {},
        fetchGeneration: state.fetchGeneration + 1,
      };
    }),

    setSharedEntries: (sharedEntries) => set({ sharedEntries }),
    getVisibleEntries: () => {
      const state = get();
      const blocked = new Set(state.blockedUserIds);
      return state.sharedEntries.filter((entry) => !blocked.has(entry.userId));
    },
    isBlocked: (userId) => get().blockedUserIds.includes(userId),
    clear: () => set((state) => ({
      blockedUserIds: [],
      sharedEntries: [],
      busyUserIds: [],
      error: null,
      lastReportStatus: null,
      blockGenerations: {},
      fetchGeneration: state.fetchGeneration + 1,
    })),

    fetchBlocks: async () => {
      const owner = requireBoundOwner(get());
      const generation = get().fetchGeneration + 1;
      set({ fetchGeneration: generation, error: null });
      try {
        const blockedUserIds = unique(await api.fetchBlocks(owner.ownerId));
        if (
          get().ownerId === owner.ownerId
          && get().ownerGeneration === owner.ownerGeneration
          && get().fetchGeneration === generation
        ) set({ blockedUserIds });
      } catch (error) {
        if (
          get().ownerId === owner.ownerId
          && get().ownerGeneration === owner.ownerGeneration
          && get().fetchGeneration === generation
        ) set({ error: errorMessage(error) });
        throw error;
      }
    },

    blockUser: async (groupId, targetUserId) => {
      if (!targetUserId) throw new Error('ブロック対象が無効です。');
      const owner = requireBoundOwner(get());
      const wasBlocked = get().blockedUserIds.includes(targetUserId);
      const generation = (get().blockGenerations[targetUserId] ?? 0) + 1;
      set((state) => ({
        blockedUserIds: unique([...state.blockedUserIds, targetUserId]),
        busyUserIds: unique([...state.busyUserIds, targetUserId]),
        blockGenerations: { ...state.blockGenerations, [targetUserId]: generation },
        error: null,
      }));
      try {
        await api.blockUser(owner.ownerId, groupId, targetUserId);
      } catch (error) {
        if (
          get().ownerId === owner.ownerId
          && get().ownerGeneration === owner.ownerGeneration
          && get().blockGenerations[targetUserId] === generation
        ) {
          set((state) => ({
            blockedUserIds: wasBlocked
              ? unique([...state.blockedUserIds, targetUserId])
              : state.blockedUserIds.filter((id) => id !== targetUserId),
            error: errorMessage(error),
          }));
        }
        throw error;
      } finally {
        if (
          get().ownerId === owner.ownerId
          && get().ownerGeneration === owner.ownerGeneration
          && get().blockGenerations[targetUserId] === generation
        ) {
          set((state) => ({ busyUserIds: state.busyUserIds.filter((id) => id !== targetUserId) }));
        }
      }
    },

    unblockUser: async (targetUserId) => {
      const owner = requireBoundOwner(get());
      const wasBlocked = get().blockedUserIds.includes(targetUserId);
      const generation = (get().blockGenerations[targetUserId] ?? 0) + 1;
      set((state) => ({
        blockedUserIds: state.blockedUserIds.filter((id) => id !== targetUserId),
        busyUserIds: unique([...state.busyUserIds, targetUserId]),
        blockGenerations: { ...state.blockGenerations, [targetUserId]: generation },
        error: null,
      }));
      try {
        await api.unblockUser(owner.ownerId, targetUserId);
      } catch (error) {
        if (
          get().ownerId === owner.ownerId
          && get().ownerGeneration === owner.ownerGeneration
          && get().blockGenerations[targetUserId] === generation
        ) {
          set((state) => ({
            blockedUserIds: wasBlocked
              ? unique([...state.blockedUserIds, targetUserId])
              : state.blockedUserIds.filter((id) => id !== targetUserId),
            error: errorMessage(error),
          }));
        }
        throw error;
      } finally {
        if (
          get().ownerId === owner.ownerId
          && get().ownerGeneration === owner.ownerGeneration
          && get().blockGenerations[targetUserId] === generation
        ) {
          set((state) => ({ busyUserIds: state.busyUserIds.filter((id) => id !== targetUserId) }));
        }
      }
    },

    reportContent: async (input) => {
      const owner = requireBoundOwner(get());
      const detail = input.detail.trim();
      if (!MODERATION_REASONS.includes(input.reason)) throw new Error('通報理由が無効です。');
      if (detail.length > 500) throw new Error('通報の詳細は500文字以内にしてください。');
      set((state) => ({
        lastReportStatus: null,
        error: null,
        busyUserIds: unique([...state.busyUserIds, input.targetUserId]),
      }));
      try {
        const result = await api.reportContent(owner.ownerId, { ...input, detail });
        if (
          get().ownerId === owner.ownerId
          && get().ownerGeneration === owner.ownerGeneration
        ) set({ lastReportStatus: result.status });
      } catch (error) {
        if (
          get().ownerId === owner.ownerId
          && get().ownerGeneration === owner.ownerGeneration
        ) set({ error: errorMessage(error) });
        throw error;
      } finally {
        if (
          get().ownerId === owner.ownerId
          && get().ownerGeneration === owner.ownerGeneration
        ) {
          set((state) => ({
            busyUserIds: state.busyUserIds.filter((id) => id !== input.targetUserId),
          }));
        }
      }
    },

    removeAndBanMember: async (groupId, targetUserId) => {
      const owner = requireBoundOwner(get());
      set((state) => ({ busyUserIds: unique([...state.busyUserIds, targetUserId]), error: null }));
      try {
        await api.removeAndBanMember(owner.ownerId, groupId, targetUserId);
      } catch (error) {
        if (
          get().ownerId === owner.ownerId
          && get().ownerGeneration === owner.ownerGeneration
        ) set({ error: errorMessage(error) });
        throw error;
      } finally {
        if (
          get().ownerId === owner.ownerId
          && get().ownerGeneration === owner.ownerGeneration
        ) set((state) => ({ busyUserIds: state.busyUserIds.filter((id) => id !== targetUserId) }));
      }
    },
  };
}

export function createModerationStore(api: ModerationApi): StoreApi<ModerationState> {
  return createStore<ModerationState>((set, get) => buildModerationState(api, set, get));
}
