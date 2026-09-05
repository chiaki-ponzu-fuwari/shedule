export async function verifyGoogleProviderToken(
  token: string,
  expectedSubject: string,
  allowedClientIds: readonly string[],
  fetchTokenInfo: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  if (!token || !expectedSubject || allowedClientIds.length === 0) {
    throw new Error('Google provider verification is unavailable');
  }
  const url = new URL('https://oauth2.googleapis.com/tokeninfo');
  url.searchParams.set('access_token', token);
  const response = await fetchTokenInfo(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Google provider token could not be verified');
  }
  const claims = payload as Record<string, unknown>;
  const expiresIn = Number(claims.expires_in);
  if (
    claims.sub !== expectedSubject
    || typeof claims.aud !== 'string'
    || !allowedClientIds.includes(claims.aud)
    || !Number.isFinite(expiresIn)
    || expiresIn <= 0
  ) {
    throw new Error('Google provider token identity did not match');
  }
}
