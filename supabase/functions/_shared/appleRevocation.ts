const MAX_APPLE_ERROR_BYTES = 4_096;

export class AppleTokenRevocationError extends Error {
  readonly retryable: boolean;

  constructor(retryable: boolean) {
    super('Apple token revocation failed');
    this.name = 'AppleTokenRevocationError';
    this.retryable = retryable;
  }
}

async function boundedOAuthError(response: Response): Promise<string | null> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_APPLE_ERROR_BYTES) return null;
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_APPLE_ERROR_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const error = (payload as { error?: unknown }).error;
    return typeof error === 'string' && error.length > 0 && error.length <= 128
      ? error
      : null;
  } catch {
    return null;
  }
}

/**
 * Apple documents a 200 response for a token that is already invalid. A
 * bounded `invalid_token`/`invalid_grant` response is equivalent. Transport,
 * timeout, throttling and 5xx failures remain retryable; other HTTP failures
 * are terminal so Recoto deletion can continue with a manual-revocation flag.
 */
export async function completeAppleTokenRevocationRequest(
  sendRequest: () => Promise<Response>,
): Promise<void> {
  let response: Response;
  try {
    response = await sendRequest();
  } catch {
    throw new AppleTokenRevocationError(true);
  }

  if (response.ok) return;
  if (response.status === 400) {
    let oauthError: string | null;
    try {
      oauthError = await boundedOAuthError(response);
    } catch {
      throw new AppleTokenRevocationError(true);
    }
    if (oauthError === 'invalid_token' || oauthError === 'invalid_grant') return;
  }
  const retryable = response.status === 408
    || response.status === 429
    || response.status >= 500;
  throw new AppleTokenRevocationError(retryable);
}
