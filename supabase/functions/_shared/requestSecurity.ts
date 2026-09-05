export class EdgeRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'EdgeRequestError';
    this.status = status;
    this.code = code;
  }
}

export function parseBearerToken(header: string | null): string {
  if (!header) {
    throw new EdgeRequestError(401, 'authorization_required', 'Authorization is required');
  }
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header);
  if (!match?.[1] || match[1].includes(',')) {
    throw new EdgeRequestError(401, 'invalid_bearer', 'A single Bearer token is required');
  }
  return match[1];
}

export function parseBoundedJsonObject(
  body: string,
  maximumBytes = 8_192,
): Record<string, unknown> {
  if (new TextEncoder().encode(body).byteLength > maximumBytes) {
    throw new EdgeRequestError(413, 'body_too_large', 'Request body is too large');
  }
  if (!body.trim()) return {};

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new EdgeRequestError(400, 'invalid_json', 'Request body must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EdgeRequestError(400, 'invalid_body', 'Request body must be an object');
  }
  return value as Record<string, unknown>;
}

export function validateWebOrigin(
  origin: string | null,
  allowedOrigins: readonly string[],
): string | null {
  if (!origin) return null;
  if (origin === '*' || !allowedOrigins.includes(origin)) {
    throw new EdgeRequestError(403, 'origin_denied', 'Web origin is not allowed');
  }
  return origin;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new EdgeRequestError(401, 'invalid_reauthentication', 'Reauthentication token is invalid');
  }
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
    return payload as Record<string, unknown>;
  } catch {
    throw new EdgeRequestError(401, 'invalid_reauthentication', 'Reauthentication token is invalid');
  }
}

/**
 * Call this only after auth.getUser(token) has cryptographically verified the
 * token. This check binds that verified session to the target UID and enforces
 * the short reauthentication window used by destructive account deletion.
 */
export function assertFreshVerifiedSession(
  verifiedToken: string,
  verifiedUserId: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
  maximumAgeSeconds = 10 * 60,
): void {
  const payload = decodeJwtPayload(verifiedToken);
  if (payload.sub !== verifiedUserId) {
    throw new EdgeRequestError(403, 'reauth_user_mismatch', 'Reauthenticated user does not match');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    throw new EdgeRequestError(401, 'reauth_expired', 'Reauthentication session has expired');
  }
  if (
    typeof payload.iat !== 'number' ||
    payload.iat > nowSeconds + 60 ||
    nowSeconds - payload.iat > maximumAgeSeconds
  ) {
    throw new EdgeRequestError(401, 'reauth_too_old', 'A recent reauthentication is required');
  }
}

/**
 * A refreshed access token has a recent `iat`, but does not prove that the
 * person just authenticated. Supabase records the actual authentication
 * method and time in `amr`, so destructive account deletion additionally
 * requires a recent interactive OAuth event.
 *
 * Call this only after auth.getUser(token) has verified the token.
 */
export function assertFreshProviderAuthentication(
  verifiedToken: string,
  verifiedUserId: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
  maximumAgeSeconds = 10 * 60,
): void {
  assertFreshVerifiedSession(
    verifiedToken,
    verifiedUserId,
    nowSeconds,
    maximumAgeSeconds,
  );
  const payload = decodeJwtPayload(verifiedToken);
  const methods = Array.isArray(payload.amr) ? payload.amr : [];
  const hasRecentOAuth = methods.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return record.method === 'oauth' &&
      typeof record.timestamp === 'number' &&
      record.timestamp <= nowSeconds + 60 &&
      nowSeconds - record.timestamp <= maximumAgeSeconds;
  });
  if (!hasRecentOAuth) {
    throw new EdgeRequestError(
      401,
      'provider_reauthentication_required',
      'A recent provider authentication is required',
    );
  }
}

export function requireString(
  body: Record<string, unknown>,
  name: string,
  maximumLength: number,
): string {
  const value = body[name];
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) {
    throw new EdgeRequestError(400, 'invalid_body', `${name} is invalid`);
  }
  return value;
}

export function requireUuid(body: Record<string, unknown>, name: string): string {
  const value = requireString(body, name, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new EdgeRequestError(400, 'invalid_body', `${name} must be a UUID`);
  }
  return value;
}

export function requireReceiptSecret(
  body: Record<string, unknown>,
  name = 'receiptSecret',
): string {
  const value = requireString(body, name, 128);
  if (value.length < 43 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new EdgeRequestError(400, 'invalid_body', `${name} is invalid`);
  }
  return value;
}
