export type AppleTokenSet = {
  refreshToken: string;
  subject: string;
  issuedAtSeconds: number;
};

type VerifiedAppleIdentity = {
  subject: string;
  issuedAtSeconds: number;
};

export interface AppleIdentityTokenVerifier {
  (
    idToken: string,
    options: { clientId: string; expectedNonceHash: string },
  ): Promise<VerifiedAppleIdentity>;
}

export async function finalizeAppleTokenPayload({
  payload,
  clientId,
  expectedNonceHash,
  verifyIdentityToken,
  revokeRefreshToken,
}: {
  payload: Record<string, unknown>;
  clientId: string;
  expectedNonceHash: string;
  verifyIdentityToken: AppleIdentityTokenVerifier;
  revokeRefreshToken: (refreshToken: string) => Promise<void>;
}): Promise<AppleTokenSet> {
  if (typeof payload.refresh_token !== 'string' || typeof payload.id_token !== 'string') {
    throw new Error('Apple token exchange was incomplete');
  }
  const refreshToken = payload.refresh_token;
  try {
    const identity = await verifyIdentityToken(payload.id_token, {
      clientId,
      expectedNonceHash,
    });
    return {
      refreshToken,
      subject: identity.subject,
      issuedAtSeconds: identity.issuedAtSeconds,
    };
  } catch (error) {
    try {
      await revokeRefreshToken(refreshToken);
    } catch {
      // Preserve the verification error. The caller must not persist an
      // unverified grant, and Apple also offers user-side manual revocation.
    }
    throw error;
  }
}
