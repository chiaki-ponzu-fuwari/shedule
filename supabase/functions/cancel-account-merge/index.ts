import { requireUuid } from '../_shared/requestSecurity.ts';
import { rpcError, serveAccountFunction } from '../_shared/runtime.ts';

serveAccountFunction(async (context) => {
  const intentId = requireUuid(context.body, 'intentId');
  const response = await context.adminClient.rpc('cancel_account_merge_intent', {
    p_intent_id: intentId,
    p_source_user_id: context.user.id,
  });
  rpcError(response.error);
  return { cancelled: response.data === true };
});
