import { sha256Hex } from '../_shared/crypto.ts';
import { requireReceiptSecret, requireUuid } from '../_shared/requestSecurity.ts';
import { rpcDataRecord, rpcError, serveAccountFunction } from '../_shared/runtime.ts';

serveAccountFunction(async (context) => {
  const requestId = requireUuid(context.body, 'requestId');
  const receiptSecret = requireReceiptSecret(context.body);
  const response = await context.adminClient.rpc('create_account_deletion_challenge', {
    p_user_id: context.user.id,
    p_request_id: requestId,
    p_receipt_secret_hash: await sha256Hex(receiptSecret),
  });
  rpcError(response.error);
  const challenge = rpcDataRecord(response.data, 'create_account_deletion_challenge');
  if (challenge.request_id !== requestId || typeof challenge.expires_at !== 'string') {
    throw new Error('Deletion challenge response did not match the request');
  }
  return {
    requestId,
    expiresAt: challenge.expires_at,
  };
});
