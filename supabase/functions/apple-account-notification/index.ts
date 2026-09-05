import {
  deleteUserStorageObjects,
  isAuthUserMissingError,
} from '../_shared/account.ts';
import { appleSubjectHash } from '../_shared/apple.ts';
import { randomNonce, sha256Hex } from '../_shared/crypto.ts';
import {
  normalizeDeletionProgress,
  mergeDeletionProgress,
} from '../_shared/deletionProgress.ts';
import { verifyAppleAccountNotification } from '../_shared/appleNotification.ts';
import { EdgeRequestError, requireString } from '../_shared/requestSecurity.ts';
import {
  rpcDataRecord,
  rpcError,
  servePublicAccountFunction,
} from '../_shared/runtime.ts';

function notificationClientIds(): string[] {
  const configured = (
    Deno.env.get('APPLE_NOTIFICATION_CLIENT_IDS')
    ?? Deno.env.get('APPLE_CLIENT_ID')
    ?? ''
  ).split(',').map((value) => value.trim()).filter(Boolean);
  if (configured.length === 0) throw new Error('Apple notification audiences are unavailable');
  return [...new Set(configured)];
}

function trustedUuid(record: Record<string, unknown>, snake: string, camel: string): string {
  const value = record[snake] ?? record[camel];
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Apple event lifecycle returned an invalid identifier');
  }
  return value;
}

servePublicAccountFunction(async (context) => {
  const payload = requireString(context.body, 'payload', 32_768);
  let notification;
  try {
    notification = await verifyAppleAccountNotification(payload, {
      clientIds: notificationClientIds(),
    });
  } catch {
    throw new EdgeRequestError(
      401,
      'invalid_apple_notification',
      'The Apple account notification is invalid',
    );
  }

  if (
    notification.type === 'email-enabled'
    || notification.type === 'email-disabled'
  ) {
    // Recoto does not use Apple's relay status for authorization or delivery.
    // Acknowledge Apple's other signed event types without touching an account.
    return { received: true, ignored: true };
  }

  const generatedRequestId = crypto.randomUUID();
  const generatedReceiptHash = await sha256Hex(randomNonce(32));
  const started = await context.adminClient.rpc('begin_apple_account_event', {
    p_event_id: notification.eventId,
    p_provider_subject_hash: await appleSubjectHash(notification.subject),
    p_event_type: notification.type,
    p_event_time: new Date(notification.eventTimeSeconds * 1_000).toISOString(),
    p_request_id: generatedRequestId,
    p_receipt_secret_hash: generatedReceiptHash,
  });
  rpcError(started.error);
  const lifecycle = rpcDataRecord(started.data, 'begin_apple_account_event');
  if (lifecycle.matched !== true) {
    return { received: true, matched: false };
  }
  if (lifecycle.status === 'completed') {
    return { received: true, matched: true, processed: true, duplicate: true };
  }

  const userId = trustedUuid(lifecycle, 'user_id', 'userId');
  const requestId = trustedUuid(lifecycle, 'request_id', 'requestId');
  let progress = normalizeDeletionProgress(lifecycle);
  let databaseComplete = progress.databaseComplete;
  try {
    // Apple has already invalidated the credential represented by the signed
    // consent-revoked/account-deleted event. The begin RPC records that durable
    // provider phase while atomically freezing all stale-JWT reads and writes.
    if (!progress.storageComplete) {
      await deleteUserStorageObjects(context.adminClient, userId);
      const storage = await context.adminClient.rpc('mark_account_deletion_phase', {
        p_user_id: userId,
        p_request_id: requestId,
        p_phase: 'storage',
        p_manual_revocation_required: progress.manualRevocationRequired,
      });
      rpcError(storage.error);
      progress = mergeDeletionProgress(
        progress,
        rpcDataRecord(storage.data, 'mark_account_deletion_phase'),
      );
    }

    if (!progress.databaseComplete) {
      const finalized = await context.adminClient.rpc('finalize_account_deletion', {
        p_user_id: userId,
        p_request_id: requestId,
      });
      rpcError(finalized.error);
      if (finalized.data !== true) throw new Error('Apple event database deletion did not complete');
      databaseComplete = true;
    }

    const authDeletion = await context.adminClient.auth.admin.deleteUser(userId, false);
    if (authDeletion.error && !isAuthUserMissingError(authDeletion.error)) {
      throw new Error('Apple event Auth deletion failed');
    }
    const completed = await context.adminClient.rpc('complete_apple_account_event', {
      p_event_id: notification.eventId,
      p_user_id: userId,
      p_request_id: requestId,
    });
    rpcError(completed.error);
    if (completed.data !== true) throw new Error('Apple event completion was not durable');
    return { received: true, matched: true, processed: true };
  } catch (error) {
    if (!databaseComplete) {
      try {
        await context.adminClient.rpc('mark_account_deletion_failed', {
          p_user_id: userId,
          p_request_id: requestId,
          p_error_code: 'apple_notification_failed',
        });
      } catch {
        // Preserve the original failure. The signed event and deletion phases
        // remain durable and the same Apple event can be retried idempotently.
      }
    }
    throw error;
  }
});
