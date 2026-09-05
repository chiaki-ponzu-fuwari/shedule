import {
  deleteUserStorageObjects,
  isAuthUserMissingError,
  providerSubject,
  revokeGoogleProviderToken,
  verifyDeletionAuthorization,
  verifyGoogleProviderToken,
} from '../_shared/account.ts';
import { decryptAppleRefreshToken, revokeAppleRefreshToken } from '../_shared/apple.ts';
import { AppleTokenRevocationError } from '../_shared/appleRevocation.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import {
  mergeDeletionProgress,
  normalizeDeletionProgress,
} from '../_shared/deletionProgress.ts';
import {
  requireReceiptSecret,
  requireString,
  requireUuid,
} from '../_shared/requestSecurity.ts';
import { rpcDataRecord, rpcError, serveAccountFunction } from '../_shared/runtime.ts';

type DeletionPhase = 'authorization' | 'provider' | 'storage' | 'database' | 'auth';

function deletionErrorCode(phase: DeletionPhase): string {
  return `${phase}_failed`;
}

function hasDurableTimestamp(
  record: Record<string, unknown>,
  snakeCase: string,
  camelCase: string,
): boolean {
  const value = record[snakeCase] ?? record[camelCase];
  return typeof value === 'string' && value.length > 0;
}

serveAccountFunction(async (context) => {
  const requestId = requireUuid(context.body, 'requestId');
  const receiptSecret = requireReceiptSecret(context.body);
  const receiptSecretHash = await sha256Hex(receiptSecret);
  const reauthenticationToken = typeof context.body.reauthenticationToken === 'string'
    ? requireString(context.body, 'reauthenticationToken', 8_192)
    : null;
  const googleProviderToken = typeof context.body.googleProviderToken === 'string'
    ? requireString(context.body, 'googleProviderToken', 8_192)
    : null;

  let phase: DeletionPhase = 'authorization';
  let deletionAuthorized = false;
  try {
    const resumable = await context.adminClient.rpc('resume_account_deletion', {
      p_user_id: context.user.id,
      p_request_id: requestId,
      p_receipt_secret_hash: receiptSecretHash,
    });
    rpcError(resumable.error);

    let freshlyVerifiedUser = context.user;
    let authorization: Record<string, unknown>;
    if (resumable.data) {
      authorization = rpcDataRecord(resumable.data, 'resume_account_deletion');
    } else {
      freshlyVerifiedUser = await verifyDeletionAuthorization(
        context,
        reauthenticationToken,
      );
      // A Google provider token is intentionally never persisted. Revoke it
      // before freezing the account, then record that result in the same
      // transaction that creates the deletion tombstone. If the process dies
      // before that transaction commits, the account remains usable and the
      // user can reauthenticate; if the response is lost after commit, resume
      // reads the durable handled marker and never degrades a successful revoke
      // into a manual-revocation warning.
      let googleRevocationHandled = false;
      let preAuthorizationManualRevocationRequired = false;
      const googleSubject = providerSubject(freshlyVerifiedUser, 'google');
      if (googleSubject) {
        googleRevocationHandled = true;
        if (googleProviderToken) {
          try {
            await verifyGoogleProviderToken(googleProviderToken, googleSubject);
            await revokeGoogleProviderToken(googleProviderToken);
          } catch {
            preAuthorizationManualRevocationRequired = true;
          }
        } else {
          preAuthorizationManualRevocationRequired = true;
        }
      }
      const authorized = await context.adminClient.rpc('authorize_account_deletion', {
        p_user_id: context.user.id,
        p_request_id: requestId,
        p_receipt_secret_hash: receiptSecretHash,
        p_google_revocation_handled: googleRevocationHandled,
        p_manual_revocation_required: preAuthorizationManualRevocationRequired,
      });
      rpcError(authorized.error);
      authorization = rpcDataRecord(authorized.data, 'authorize_account_deletion');
    }
    if (
      (authorization.request_id ?? authorization.requestId) !== requestId ||
      (authorization.user_id ?? authorization.userId) !== context.user.id
    ) {
      throw new Error('Deletion authorization did not match the verified account');
    }
    deletionAuthorized = true;
    let progress = normalizeDeletionProgress(authorization);
    const googleRevocationHandled = hasDurableTimestamp(
      authorization,
      'google_revocation_handled_at',
      'googleRevocationHandledAt',
    );

    if (!progress.providerComplete) {
      phase = 'provider';
      let manualRevocationRequired = progress.manualRevocationRequired;
      const appleSubject = providerSubject(freshlyVerifiedUser, 'apple');
      const appleCredential = await context.adminClient.rpc(
        'get_apple_credential_for_deletion',
        { p_user_id: context.user.id },
      );
      rpcError(appleCredential.error);
      if (appleCredential.data) {
        try {
          const record = rpcDataRecord(
            appleCredential.data,
            'get_apple_credential_for_deletion',
          );
          if (
            typeof record.ciphertextBase64 !== 'string' ||
            typeof record.encryptionKeyId !== 'string'
          ) {
            throw new Error('Stored Apple credential is invalid');
          }
          await revokeAppleRefreshToken(await decryptAppleRefreshToken(
            record.ciphertextBase64,
            record.encryptionKeyId,
          ));
        } catch (error) {
          if (error instanceof AppleTokenRevocationError && error.retryable) {
            // Preserve the encrypted credential and leave the provider phase
            // incomplete so a later retry can revoke the same Apple grant.
            throw error;
          }
          // Deleting Recoto data must remain possible even when a legacy Apple
          // grant is damaged or its encryption key is no longer available.
          manualRevocationRequired = true;
        }
      } else if (appleSubject) {
        manualRevocationRequired = true;
      }

      const googleSubject = providerSubject(freshlyVerifiedUser, 'google');
      if (googleSubject && !googleRevocationHandled) {
        // Compatibility for an authorization receipt created before the
        // durable Google marker existed. The ephemeral provider token must not
        // be trusted after the authorization boundary; ask the user to revoke
        // the legacy grant manually instead.
        manualRevocationRequired = true;
      }

      const providerProgress = await context.adminClient.rpc('mark_account_deletion_phase', {
        p_user_id: context.user.id,
        p_request_id: requestId,
        p_phase: 'provider',
        p_manual_revocation_required: manualRevocationRequired,
      });
      rpcError(providerProgress.error);
      progress = mergeDeletionProgress(
        progress,
        rpcDataRecord(providerProgress.data, 'mark_account_deletion_phase'),
      );
    }

    if (!progress.storageComplete) {
      phase = 'storage';
      await deleteUserStorageObjects(context.adminClient, context.user.id);
      const storageProgress = await context.adminClient.rpc('mark_account_deletion_phase', {
        p_user_id: context.user.id,
        p_request_id: requestId,
        p_phase: 'storage',
        p_manual_revocation_required: progress.manualRevocationRequired,
      });
      rpcError(storageProgress.error);
      progress = mergeDeletionProgress(
        progress,
        rpcDataRecord(storageProgress.data, 'mark_account_deletion_phase'),
      );
    }

    if (!progress.databaseComplete) {
      phase = 'database';
      const finalized = await context.adminClient.rpc('finalize_account_deletion', {
        p_user_id: context.user.id,
        p_request_id: requestId,
      });
      rpcError(finalized.error);
      if (finalized.data !== true) throw new Error('Database deletion did not complete');
      progress = { ...progress, databaseComplete: true };
    }

    phase = 'auth';
    // Auth is deliberately last. Before this succeeds, the durable deletion
    // tombstone blocks stale JWTs and the same request remains retryable.
    const authDeletion = await context.adminClient.auth.admin.deleteUser(context.user.id, false);
    if (authDeletion.error && !isAuthUserMissingError(authDeletion.error)) {
      throw new Error('Auth deletion failed');
    }

    const completed = await context.adminClient.rpc('complete_account_deletion_receipt', {
      p_request_id: requestId,
      p_receipt_secret_hash: receiptSecretHash,
    });
    rpcError(completed.error);
    const receipt = rpcDataRecord(completed.data, 'complete_account_deletion_receipt');

    return {
      deleted: true,
      requestId,
      manualRevocationRequired:
        progress.manualRevocationRequired
        || receipt.manual_revocation_required === true
        || receipt.manualRevocationRequired === true,
    };
  } catch (error) {
    if (deletionAuthorized) {
      try {
        await context.adminClient.rpc('mark_account_deletion_failed', {
          p_user_id: context.user.id,
          p_request_id: requestId,
          p_error_code: deletionErrorCode(phase),
        });
      } catch {
        // The original failure remains authoritative. A retry or status query
        // can recover from any durable phase already completed.
      }
    }
    throw error;
  }
});
