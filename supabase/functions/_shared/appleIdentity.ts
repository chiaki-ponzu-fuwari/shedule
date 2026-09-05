const APPLE_ISSUER = 'https://appleid.apple.com';

export type AppleIdentityVerificationOptions = {
  clientId: string;
  expectedNonceHash: string;
  nowSeconds?: number;
  fetchJwks?: (input: string, init?: RequestInit) => Promise<Response>;
};

export type VerifiedAppleIdentity = {
  subject: string;
  issuedAtSeconds: number;
};

type AppleJwk = JsonWebKey & {
  kid: string;
  alg?: string;
  use?: string;
  kty: string;
};

let cachedAppleKeys: { expiresAt: number; keys: AppleJwk[] } | null = null;

function decodeBase64Url(value: string): Uint8Array {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error('Apple identity token encoding is invalid');
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function decodeJsonPart(value: string, label: string): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(value)),
    );
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch {
    throw new Error(`Apple identity token ${label} is invalid`);
  }
}

async function fetchAppleKeys(
  fetchJwks: (input: string, init?: RequestInit) => Promise<Response>,
  forceRefresh = false,
): Promise<AppleJwk[]> {
  const useSharedCache = fetchJwks === fetch;
  if (!forceRefresh && useSharedCache && cachedAppleKeys && cachedAppleKeys.expiresAt > Date.now()) {
    return cachedAppleKeys.keys;
  }
  const response = await fetchJwks('https://appleid.apple.com/auth/keys', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Apple signing keys could not be loaded');
  }
  const candidates = (body as { keys?: unknown }).keys;
  if (!Array.isArray(candidates)) throw new Error('Apple signing keys are invalid');
  const keys = candidates.filter((candidate): candidate is AppleJwk => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const value = candidate as Record<string, unknown>;
    return value.kty === 'RSA' && typeof value.kid === 'string' &&
      (value.alg === undefined || value.alg === 'RS256') &&
      (value.use === undefined || value.use === 'sig');
  });
  if (keys.length === 0) throw new Error('Apple signing keys are invalid');
  if (useSharedCache) {
    cachedAppleKeys = { keys, expiresAt: Date.now() + 60 * 60 * 1_000 };
  }
  return keys;
}

export async function verifyAppleIdentityToken(
  idToken: string,
  options: AppleIdentityVerificationOptions,
): Promise<VerifiedAppleIdentity> {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('Apple identity token is invalid');
  }
  const header = decodeJsonPart(parts[0], 'header');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new Error('Apple identity token algorithm is invalid');
  }
  const fetchJwks = options.fetchJwks ?? fetch;
  let signingKey = (await fetchAppleKeys(fetchJwks)).find((key) => key.kid === header.kid);
  if (!signingKey) {
    // Apple may rotate signing keys while an Edge isolate still holds the old
    // set. A single forced refresh avoids rejecting a valid new key for an hour.
    signingKey = (await fetchAppleKeys(fetchJwks, true)).find((key) => key.kid === header.kid);
  }
  if (!signingKey) throw new Error('Apple identity token signing key is unknown');
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    signingKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signatureValid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    publicKey,
    asArrayBuffer(decodeBase64Url(parts[2])),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!signatureValid) throw new Error('Apple identity token signature is invalid');

  const payload = decodeJsonPart(parts[1], 'payload');
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (
    payload.iss !== APPLE_ISSUER ||
    !audiences.includes(options.clientId) ||
    typeof payload.exp !== 'number' ||
    payload.exp <= now ||
    typeof payload.iat !== 'number' ||
    payload.iat > now + 60 ||
    now - payload.iat > 10 * 60 ||
    typeof payload.sub !== 'string' ||
    !payload.sub
  ) {
    throw new Error('Apple identity token claims are invalid');
  }
  if (payload.nonce !== options.expectedNonceHash) {
    throw new Error('Apple identity token nonce is invalid');
  }
  return {
    subject: payload.sub,
    issuedAtSeconds: payload.iat,
  };
}
