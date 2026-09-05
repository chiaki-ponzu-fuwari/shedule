import { randomNonce, sha256Hex } from '../_shared/crypto.ts';
import { EdgeRequestError } from '../_shared/requestSecurity.ts';
import { rpcDataRecord, rpcError, serveAccountFunction } from '../_shared/runtime.ts';

serveAccountFunction(async (context) => {
  if (context.user.is_anonymous !== true) {
    throw new EdgeRequestError(
      409,
      'guest_merge_only',
      'Only guest data can be merged into an existing account',
    );
  }

  const nonce = randomNonce(32);
  const response = await context.adminClient.rpc('create_account_merge_intent', {
    p_source_user_id: context.user.id,
    p_nonce_hash: await sha256Hex(nonce),
  });
  rpcError(response.error);
  const intent = rpcDataRecord(response.data, 'create_account_merge_intent');
  if (typeof intent.id !== 'string' || typeof intent.expires_at !== 'string') {
    throw new Error('Merge intent response is incomplete');
  }

  return {
    intentId: intent.id,
    nonce,
    expiresAt: intent.expires_at,
  };
});
