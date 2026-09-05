const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_NOTIFICATION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

type AppleJwk = JsonWebKey & {
  kid: string;
  alg?: string;
  use?: string;
  kty: string;
};

export type AppleAccountEventType =
  | 'email-enabled'
  | 'email-disabled'
  | 'consent-revoked'
  | 'account-deleted';

export interface VerifiedAppleAccountNotification {
  eventId: string;
  type: AppleAccountEventType;
  subject: string;
  eventTimeSeconds: number;
  audience: string;
}

export interface AppleAccountNotificationVerificationOptions {
  clientIds: readonly string[];
  nowSeconds?: number;
  fetchJwks?: (input: string, init?: RequestInit) => Promise<Response>;
}

let cachedAppleKeys: { expiresAt: number; keys: AppleJwk[] } | null = null;

function decodeBase64Url(value: string): Uint8Array {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error('Apple notification encoding is invalid');
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function decodeRecord(value: string, label: string): Record<string, unknown> {
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(value)),
    );
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
    return decoded as Record<string, unknown>;
  } catch {
    throw new Error(`Apple notification ${label} is invalid`);
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
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Apple notification signing keys could not be loaded');
  }
  const candidates = (payload as { keys?: unknown }).keys;
  if (!Array.isArray(candidates)) throw new Error('Apple notification signing keys are invalid');
  const keys = candidates.filter((candidate): candidate is AppleJwk => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const value = candidate as Record<string, unknown>;
    return value.kty === 'RSA'
      && typeof value.kid === 'string'
      && Boolean(value.kid)
      && (value.alg === undefined || value.alg === 'RS256')
      && (value.use === undefined || value.use === 'sig');
  });
  if (keys.length === 0) throw new Error('Apple notification signing keys are invalid');
  if (useSharedCache) cachedAppleKeys = { keys, expiresAt: Date.now() + 60 * 60 * 1_000 };
  return keys;
}

function parseEvents(value: unknown): Record<string, unknown> {
  let events = value;
  if (typeof events === 'string') {
    if (events.length > 8_192) throw new Error('Apple notification event is invalid');
    try {
      events = JSON.parse(events);
    } catch {
      throw new Error('Apple notification event is invalid');
    }
  }
  if (!events || typeof events !== 'object' || Array.isArray(events)) {
    throw new Error('Apple notification event is invalid');
  }
  return events as Record<string, unknown>;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : null;
}

function eventTimeSeconds(value: unknown, nowSeconds: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  const seconds = value > 10_000_000_000 ? value / 1_000 : value;
  return seconds <= nowSeconds + 5 * 60
    && seconds >= nowSeconds - APPLE_NOTIFICATION_MAX_AGE_SECONDS
    ? seconds
    : null;
}

/** Verifies the Apple-signed JWS before exposing any account routing fields. */
export async function verifyAppleAccountNotification(
  token: string,
  options: AppleAccountNotificationVerificationOptions,
): Promise<VerifiedAppleAccountNotification> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('Apple notification is invalid');
  }
  const header = decodeRecord(parts[0], 'header');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new Error('Apple notification algorithm is invalid');
  }
  const fetchJwks = options.fetchJwks ?? fetch;
  let signingKey = (await fetchAppleKeys(fetchJwks)).find((key) => key.kid === header.kid);
  if (!signingKey) {
    signingKey = (await fetchAppleKeys(fetchJwks, true)).find((key) => key.kid === header.kid);
  }
  if (!signingKey) throw new Error('Apple notification signing key is unknown');
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
  if (!signatureValid) throw new Error('Apple notification signature is invalid');

  const claims = decodeRecord(parts[1], 'payload');
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const clientIds = new Set(options.clientIds.filter((value) => value.trim()));
  const audience = boundedString(claims.aud, 512);
  const issuedAt = claims.iat;
  const expiresAt = claims.exp;
  if (
    claims.iss !== APPLE_ISSUER
    || !audience
    || !clientIds.has(audience)
    || typeof issuedAt !== 'number'
    || !Number.isSafeInteger(issuedAt)
    || issuedAt > nowSeconds + 60
    || issuedAt < nowSeconds - APPLE_NOTIFICATION_MAX_AGE_SECONDS
    || (
      expiresAt !== undefined
      && (
        typeof expiresAt !== 'number'
        || !Number.isSafeInteger(expiresAt)
        || expiresAt <= nowSeconds
        || expiresAt <= issuedAt
      )
    )
  ) {
    throw new Error('Apple notification claims are invalid');
  }
  const eventId = boundedString(claims.jti, 512);
  if (!eventId) throw new Error('Apple notification claims are invalid');

  const events = parseEvents(claims.events);
  const type = events.type;
  const subject = boundedString(events.sub, 1_024);
  const occurredAt = eventTimeSeconds(events.event_time, nowSeconds);
  if (
    (
      type !== 'email-enabled'
      && type !== 'email-disabled'
      && type !== 'consent-revoked'
      && type !== 'account-deleted'
    )
    || !subject
    || occurredAt === null
  ) {
    throw new Error('Apple notification event is invalid');
  }
  return {
    eventId,
    type,
    subject,
    eventTimeSeconds: occurredAt,
    audience,
  };
}
