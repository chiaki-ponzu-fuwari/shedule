import * as Crypto from 'expo-crypto';
import { requireSupabaseClient } from '../supabase';
import { useAppSessionStore } from '../../store/appSessionStore';
import type {
  ModerationApi,
  ModerationReportInput,
  ModerationReportResult,
} from '../../store/moderationStore';

async function requireModerationSession(expectedOwnerId: string) {
  const userId = await useAppSessionStore.getState().ensureGuestSession('group-action');
  if (!userId || userId !== expectedOwnerId) {
    throw new Error('認証状態が変更されたため、グループ操作を中止しました。');
  }
  return { client: requireSupabaseClient(), userId };
}

function throwRpcError(action: string, error: { message?: string } | null) {
  throw new Error(`${action}に失敗しました。接続を確認して再度お試しください。${error?.message ? ` (${error.message})` : ''}`);
}

export function createSupabaseModerationApi(): ModerationApi {
  return {
    async fetchBlocks(ownerId) {
      const { client, userId } = await requireModerationSession(ownerId);
      const { data, error } = await client
        .from('user_blocks')
        .select('blocked_user_id')
        .eq('blocker_user_id', userId);
      if (error) throwRpcError('ブロック一覧の取得', error);
      return (data ?? [])
        .map((row: { blocked_user_id?: unknown }) => row.blocked_user_id)
        .filter((value): value is string => typeof value === 'string');
    },

    async blockUser(ownerId, groupId, targetUserId) {
      const { client } = await requireModerationSession(ownerId);
      const { error } = await client.rpc('block_group_user', {
        p_group_id: groupId,
        p_blocked_user_id: targetUserId,
      });
      if (error) throwRpcError('ユーザーのブロック', error);
    },

    async unblockUser(ownerId, targetUserId) {
      const { client } = await requireModerationSession(ownerId);
      const { error } = await client.rpc('unblock_user', {
        p_blocked_user_id: targetUserId,
      });
      if (error) throwRpcError('ブロックの解除', error);
    },

    async reportContent(ownerId, input: ModerationReportInput): Promise<ModerationReportResult> {
      const { client } = await requireModerationSession(ownerId);
      const { data, error } = await client.rpc('report_group_content', {
        p_group_id: input.groupId,
        p_target_user_id: input.targetUserId,
        p_shared_entry_id: input.sharedEntryId ?? null,
        p_reason: input.reason,
        p_detail: input.detail,
        p_client_report_id: input.clientReportId ?? Crypto.randomUUID(),
      });
      if (error) throwRpcError('通報', error);
      const result = data as { status?: unknown; reportId?: unknown } | null;
      if (result?.status !== 'received') throwRpcError('通報', null);
      return {
        status: 'received',
        reportId: typeof result?.reportId === 'string' ? result.reportId : undefined,
      };
    },

    async removeAndBanMember(ownerId, groupId, targetUserId) {
      const { client } = await requireModerationSession(ownerId);
      const { error } = await client.rpc('remove_and_ban_group_member', {
        p_group_id: groupId,
        p_member_user_id: targetUserId,
      });
      if (error) throwRpcError('メンバーの除名', error);
    },
  };
}
