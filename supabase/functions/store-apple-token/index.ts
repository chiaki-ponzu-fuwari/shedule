import {
  appleSubjectHash,
  encryptAppleRefreshToken,
  exchangeAppleAuthorizationCode,
  revokeAppleRefreshToken,
} from '../_shared/apple.ts';
import { providerSubject } from '../_shared/account.ts';
import { EdgeRequestError, requireString } from '../_shared/requestSecurity.ts';
import { rpcError, serveAccountFunction } from '../_shared/runtime.ts';

serveAccountFunction(async (context) => {
  if (context.user.is_anonymous === true) {
    throw new EdgeRequestError(403, 'account_required', 'A connected Apple account is required');
  }
  const authorizationCode = requireString(context.body, 'authorizationCode', 4_096);
  const expectedNonceHash = requireString(context.body, 'expectedNonceHash', 128);
  const verifiedSubject = providerSubject(context.user, 'apple');
  if (!verifiedSubject) {
    throw new EdgeRequestError(403, 'apple_identity_mismatch', 'Apple identity did not match');
  }
  const providerSubjectHash = await appleSubjectHash(verifiedSubject);
  const claimId = crypto.randomUUID();
  const claim = await context.adminClient.rpc('begin_apple_credential_store', {
    p_user_id: context.user.id,
    p_provider_subject_hash: providerSubjectHash,
    p_claim_id: claimId,
  });
  rpcError(claim.error);
  if (claim.data === 'existing') return { stored: true, existing: true };
  if (claim.data === 'uncertain') {
    throw new EdgeRequestError(
      409,
      'apple_credential_store_repair_required',
      'A previous Apple credential exchange requires reconciliation',
    );
  }
  if (claim.data === 'pending') {
    throw new EdgeRequestError(
      409,
      'apple_credential_store_pending',
      'Apple credential storage is already in progress',
    );
  }
  if (claim.data !== 'acquired') throw new Error('Apple credential claim was invalid');

  // Persist the irreversible boundary before calling Apple's single-use code
  // endpoint. Once set, the claim never expires into another automatic exchange.
  const exchangeStarted = await context.adminClient.rpc('mark_apple_credential_exchange_started', {
    p_user_id: context.user.id,
    p_provider_subject_hash: providerSubjectHash,
    p_claim_id: claimId,
  });
  rpcError(exchangeStarted.error);
  if (exchangeStarted.data !== true) {
    throw new Error('Apple credential exchange claim was unavailable');
  }

  let tokens: Awaited<ReturnType<typeof exchangeAppleAuthorizationCode>> | null = null;
  let storageAttempted = false;
  try {
    tokens = await exchangeAppleAuthorizationCode(authorizationCode, expectedNonceHash);
    if (verifiedSubject !== tokens.subject) {
      throw new EdgeRequestError(403, 'apple_identity_mismatch', 'Apple identity did not match');
    }
    const encrypted = await encryptAppleRefreshToken(tokens.refreshToken);
    let lastError: { message?: string; code?: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      storageAttempted = true;
      const response = await context.adminClient.rpc('complete_apple_credential_store', {
        p_user_id: context.user.id,
        p_provider_subject_hash: providerSubjectHash,
        p_claim_id: claimId,
        p_ciphertext_base64: encrypted.ciphertextBase64,
        p_encryption_key_id: encrypted.encryptionKeyId,
        p_credential_issued_at: new Date(tokens.issuedAtSeconds * 1_000).toISOString(),
      });
      if (!response.error) {
        if (response.data === true) return { stored: true };
        throw new Error('Apple credential storage returned an invalid response');
      }
      lastError = response.error;
    }
    rpcError(lastError);
    throw new Error('Apple credential storage failed');
  } catch (error) {
    if (tokens && storageAttempted) {
      // An RPC response can disappear after its transaction commits. Verify
      // the subject-bound row before deciding whether this token is untracked.
      const status = await context.adminClient.rpc('has_apple_credential', {
        p_user_id: context.user.id,
        p_provider_subject_hash: providerSubjectHash,
      });
      if (!status.error && status.data === true) return { stored: true, recovered: true };
    }

    let safeToReleaseClaim = false;
    if (tokens) {
      try {
        await revokeAppleRefreshToken(tokens.refreshToken);
        safeToReleaseClaim = true;
      } catch {
        // Never auto-expire an exchange-started claim: the single-use code may
        // already have produced a live grant that this process cannot track.
      }
    }
    if (safeToReleaseClaim) {
      try {
        await context.adminClient.rpc('reconcile_apple_credential_store', {
          p_user_id: context.user.id,
          p_provider_subject_hash: providerSubjectHash,
          p_claim_id: claimId,
          p_provider_revocation_confirmed: true,
        });
      } catch {
        // Reconciliation is best effort after Apple has confirmed revocation.
      }
    }
    throw error;
  }
});
