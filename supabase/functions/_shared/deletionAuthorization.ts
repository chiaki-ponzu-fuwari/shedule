import { assertFreshProviderAuthentication, EdgeRequestError } from './requestSecurity.ts';

export interface DeletionIdentity {
  id: string;
  is_anonymous?: boolean;
}

export async function authorizeDeletionSession<T extends DeletionIdentity>({
  currentUser,
  reauthenticationToken,
  verifyToken,
}: {
  currentUser: T;
  reauthenticationToken: string | null;
  verifyToken(token: string): Promise<T | null>;
}): Promise<T> {
  if (currentUser.is_anonymous === true) return currentUser;
  if (!reauthenticationToken) {
    throw new EdgeRequestError(401, 'reauthentication_required', 'Fresh reauthentication is required');
  }
  const verified = await verifyToken(reauthenticationToken);
  if (!verified) {
    throw new EdgeRequestError(401, 'invalid_reauthentication', 'Reauthentication could not be verified');
  }
  if (verified.id !== currentUser.id) {
    throw new EdgeRequestError(403, 'reauth_user_mismatch', 'Reauthenticated user does not match');
  }
  if (verified.is_anonymous === true) {
    throw new EdgeRequestError(403, 'account_required', 'A connected account is required');
  }
  assertFreshProviderAuthentication(reauthenticationToken, verified.id);
  return verified;
}
