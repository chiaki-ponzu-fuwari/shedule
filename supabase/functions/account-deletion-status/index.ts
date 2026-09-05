import { sha256Hex } from '../_shared/crypto.ts';
import { normalizePublicDeletionStatus } from '../_shared/deletionProgress.ts';
import { requireReceiptSecret, requireUuid } from '../_shared/requestSecurity.ts';
import {
  rpcDataRecord,
  rpcError,
  servePublicAccountFunction,
} from '../_shared/runtime.ts';

servePublicAccountFunction(async (context) => {
  const requestId = requireUuid(context.body, 'requestId');
  const receiptSecret = requireReceiptSecret(context.body);
  const receiptSecretHash = await sha256Hex(receiptSecret);
  const response = await context.adminClient.rpc('get_account_deletion_status', {
    p_request_id: requestId,
    p_receipt_secret_hash: receiptSecretHash,
  });
  rpcError(response.error);
  let status = rpcDataRecord(response.data, 'get_account_deletion_status');

  // Recover the narrow crash window after Auth deletion but before the final
  // receipt update. The RPC checks Auth server-side and returns db-cleared
  // unchanged while the user still exists.
  if (status.status === 'db-cleared') {
    const completed = await context.adminClient.rpc('complete_account_deletion_receipt', {
      p_request_id: requestId,
      p_receipt_secret_hash: receiptSecretHash,
    });
    rpcError(completed.error);
    status = rpcDataRecord(completed.data, 'complete_account_deletion_receipt');
  }

  const publicStatus = normalizePublicDeletionStatus(status.status);
  return {
    requestId,
    status: publicStatus,
    manualRevocationRequired: status.manualRevocationRequired === true,
    retryable: publicStatus !== 'completed' && status.retryable !== false,
  };
});
