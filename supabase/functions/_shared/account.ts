import type { User } from './deps.ts';
import { authorizeDeletionSession } from './deletionAuthorization.ts';
import { verifyGoogleProviderToken as verifyGoogleToken } from './googleIdentity.ts';
import type { AccountFunctionContext } from './runtime.ts';
export { deleteUserStorageObjects } from './storage.ts';

export async function verifyReauthentication(
  context: AccountFunctionContext,
  reauthenticationToken: string,
): Promise<User> {
  return authorizeDeletionSession({
    currentUser: context.user,
    reauthenticationToken,
    verifyToken: async (token) => {
      const response = await context.adminClient.auth.getUser(token);
      return response.error ? null : response.data.user;
    },
  });
}

export async function verifyDeletionAuthorization(
  context: AccountFunctionContext,
  reauthenticationToken: string | null,
): Promise<User> {
  if (context.user.is_anonymous !== true && reauthenticationToken) {
    return verifyReauthentication(context, reauthenticationToken);
  }
  return authorizeDeletionSession({
    currentUser: context.user,
    reauthenticationToken,
    verifyToken: async () => null,
  });
}

export function providerSubject(user: User, provider: 'apple' | 'google'): string | null {
  const identity = user.identities?.find((candidate) => candidate.provider === provider);
  if (!identity) return null;
  const data = identity.identity_data as Record<string, unknown> | undefined;
  const subject = data?.sub;
  if (typeof subject === 'string' && subject) return subject;
  return typeof identity.id === 'string' && identity.id ? identity.id : null;
}

export function isAuthUserMissingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof value.code === 'string' ? value.code.toLowerCase() : '';
  const message = typeof value.message === 'string' ? value.message.toLowerCase() : '';
  return value.status === 404 || code === 'user_not_found' || message.includes('user not found');
}

function configuredGoogleClientIds(): string[] {
  return (Deno.env.get('GOOGLE_OAUTH_CLIENT_IDS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function verifyGoogleProviderToken(
  token: string,
  expectedSubject: string,
  allowedClientIds: readonly string[] = configuredGoogleClientIds(),
): Promise<void> {
  return verifyGoogleToken(token, expectedSubject, allowedClientIds);
}

export async function revokeGoogleProviderToken(token: string): Promise<void> {
  const response = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Google token revocation failed');
}
