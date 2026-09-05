import { sha256Hex } from '../_shared/crypto.ts';
import { isAuthUserMissingError } from '../_shared/account.ts';
import { EdgeRequestError, requireString, requireUuid } from '../_shared/requestSecurity.ts';
import { rpcDataRecord, rpcError, serveAccountFunction } from '../_shared/runtime.ts';
import { copyUserStorageObjects, deleteUserStorageObjects } from '../_shared/storage.ts';

serveAccountFunction(async (context) => {
  if (context.user.is_anonymous === true) {
    throw new EdgeRequestError(403, 'account_required', 'The target must be a connected account');
  }
  const intentId = requireUuid(context.body, 'intentId');
  const nonce = requireString(context.body, 'nonce', 128);

  const consumed = await context.adminClient.rpc('consume_account_merge_intent', {
    p_nonce_hash: await sha256Hex(nonce),
    p_target_user_id: context.user.id,
  });
  rpcError(consumed.error);
  const intent = rpcDataRecord(consumed.data, 'consume_account_merge_intent');
  if (intent.id !== intentId || typeof intent.source_user_id !== 'string') {
    throw new EdgeRequestError(403, 'merge_intent_mismatch', 'Merge intent did not match');
  }

  await copyUserStorageObjects(context.adminClient, intent.source_user_id, context.user.id);

  const merged = await context.adminClient.rpc('merge_account_data', {
    p_intent_id: intentId,
    p_source_user_id: intent.source_user_id,
    p_target_user_id: context.user.id,
    p_media_copied: true,
  });
  rpcError(merged.error);
  const result = rpcDataRecord(merged.data, 'merge_account_data');
  if (result.status === 'media-copy-required') {
    throw new EdgeRequestError(
      409,
      'media_copy_required',
      'Account media must finish syncing before this merge can continue',
    );
  }
  if (
    result.status !== 'merged' ||
    result.targetUserId !== context.user.id ||
    result.sourceUserId !== intent.source_user_id
  ) {
    throw new Error('Merge result did not match the verified identities');
  }

  await deleteUserStorageObjects(context.adminClient, intent.source_user_id);

  const deletion = await context.adminClient.auth.admin.deleteUser(intent.source_user_id, false);
  if (deletion.error && !isAuthUserMissingError(deletion.error)) {
    const lookup = await context.adminClient.auth.admin.getUserById(intent.source_user_id);
    if (!isAuthUserMissingError(lookup.error) || lookup.data.user) {
      throw new Error('Merged guest Auth cleanup failed');
    }
  }
  return { userId: context.user.id };
});
