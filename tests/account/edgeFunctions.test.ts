import fs from 'node:fs';
import path from 'node:path';

import {
  assertFreshVerifiedSession,
  parseBearerToken,
  parseBoundedJsonObject,
  validateWebOrigin,
} from '../../supabase/functions/_shared/requestSecurity';
import { randomNonce, sha256Hex } from '../../supabase/functions/_shared/crypto';
import { verifyAppleIdentityToken } from '../../supabase/functions/_shared/appleIdentity';
import { verifyAppleAccountNotification } from '../../supabase/functions/_shared/appleNotification';
import { finalizeAppleTokenPayload } from '../../supabase/functions/_shared/appleTokenPayload';
import {
  AppleTokenRevocationError,
  completeAppleTokenRevocationRequest,
} from '../../supabase/functions/_shared/appleRevocation';
import { verifyGoogleProviderToken } from '../../supabase/functions/_shared/googleIdentity';
import { authorizeDeletionSession } from '../../supabase/functions/_shared/deletionAuthorization';
import {
  mergeDeletionProgress,
  normalizeDeletionProgress,
  normalizePublicDeletionStatus,
} from '../../supabase/functions/_shared/deletionProgress';
import { readBoundedRequestBody } from '../../supabase/functions/_shared/boundedBody';
import { createCorsHeaders } from '../../supabase/functions/_shared/http';
import {
  StorageDeletionIncompleteError,
  copyUserStorageObjects,
  deleteUserStorageObjects,
} from '../../supabase/functions/_shared/storage';

const ROOT = path.resolve(__dirname, '../..');
const FUNCTIONS = path.join(ROOT, 'supabase/functions');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(FUNCTIONS, relativePath), 'utf8');
}

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `verified-header.${encoded}.verified-signature`;
}

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  return bytes.toString('base64url');
}

describe('Edge Function request security', () => {
  test('documents every provider allowlist required by deployed functions', () => {
    const environmentExample = read('.env.example');

    expect(environmentExample).toMatch(/^GOOGLE_OAUTH_CLIENT_IDS=/m);
    expect(environmentExample).toMatch(/^APPLE_NOTIFICATION_CLIENT_IDS=/m);
  });

  test('creates an unpredictable URL-safe merge nonce and a stable SHA-256 digest', async () => {
    const first = randomNonce(32);
    const second = randomNonce(32);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    await expect(sha256Hex('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('accepts exactly one bearer credential', () => {
    expect(parseBearerToken('Bearer signed.jwt.value')).toBe('signed.jwt.value');
    expect(() => parseBearerToken(null)).toThrow(/authorization/i);
    expect(() => parseBearerToken('Basic abc')).toThrow(/bearer/i);
    expect(() => parseBearerToken('Bearer one, Bearer two')).toThrow(/bearer/i);
  });

  test('bounds JSON before parsing and rejects arrays', () => {
    expect(parseBoundedJsonObject('{"intentId":"123"}', 128)).toEqual({ intentId: '123' });
    expect(() => parseBoundedJsonObject('[]', 128)).toThrow(/object/i);
    expect(() => parseBoundedJsonObject('{"value":"123456"}', 8)).toThrow(/large/i);
  });

  test('stops reading a chunked body as soon as the byte limit is exceeded', async () => {
    const cancel = jest.fn(async () => undefined);
    const chunks = [new Uint8Array(6), new Uint8Array(6)];
    const read = jest.fn(async () => {
      const value = chunks.shift();
      return value ? { done: false as const, value } : { done: true as const, value: undefined };
    });
    const request = {
      headers: { get: () => null },
      body: { getReader: () => ({ read, cancel, releaseLock: jest.fn() }) },
    } as any;

    await expect(readBoundedRequestBody(request, 8)).rejects.toThrow(/large/i);
    expect(read).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalled();
  });

  test('allows the Supabase browser client headers without a wildcard', () => {
    const headers = createCorsHeaders('https://recoto.example');
    expect(headers.get('Access-Control-Allow-Origin')).toBe('https://recoto.example');
    expect(headers.get('Access-Control-Allow-Headers')?.split(/,\s*/)).toEqual(
      expect.arrayContaining(['authorization', 'apikey', 'content-type', 'x-client-info']),
    );
    expect(headers.get('Access-Control-Allow-Origin')).not.toBe('*');
  });

  test('makes durable deletion progress before asking a large account to retry', async () => {
    const names = Array.from({ length: 205 }, (_, index) => `image-${index}.jpg`);
    const remove = jest.fn(async (batch: string[]) => {
      for (const name of batch) names.splice(names.indexOf(name.split('/').pop()!), 1);
      return { error: null };
    });
    const client = {
      storage: {
        from: () => ({
          list: async () => ({
            data: names.slice(0, 100).map((name) => ({ id: name, name, metadata: {} })),
            error: null,
          }),
          remove,
          copy: jest.fn(),
        }),
      },
    } as any;

    await expect(deleteUserStorageObjects(client, 'user-1', 100)).rejects.toBeInstanceOf(
      StorageDeletionIncompleteError,
    );
    expect(remove).toHaveBeenCalled();
    expect(names).toHaveLength(105);
    await expect(deleteUserStorageObjects(client, 'user-1', 300)).resolves.toBeUndefined();
    expect(names).toHaveLength(0);
  });

  test('copies guest media to the target prefix with deterministic object keys', async () => {
    const copy = jest.fn(async () => ({ error: null }));
    const client = {
      storage: {
        from: () => ({
          list: async (prefix: string) => ({
            data: prefix === 'guest-1'
              ? [{ id: null, name: 'trip', metadata: null }]
              : [{ id: 'object-1', name: 'photo.jpg', metadata: {} }],
            error: null,
          }),
          remove: jest.fn(),
          copy,
        }),
      },
    } as any;

    await expect(copyUserStorageObjects(client, 'guest-1', 'user-9')).resolves.toEqual({
      copied: 1,
    });
    expect(copy).toHaveBeenCalledWith(
      'guest-1/trip/photo.jpg',
      'user-9/trip/photo.jpg',
    );
  });

  test('allows native requests without Origin and exact configured web origins only', () => {
    const allowlist = ['https://recoto.example', 'http://localhost:8081'];
    expect(validateWebOrigin(null, allowlist)).toBeNull();
    expect(validateWebOrigin('https://recoto.example', allowlist)).toBe(
      'https://recoto.example',
    );
    expect(() => validateWebOrigin('https://recoto.example.evil.test', allowlist)).toThrow(
      /origin/i,
    );
  });

  test('requires a freshly issued, server-verified session for destructive work', () => {
    const now = 1_800_000_000;
    const fresh = jwt({ sub: 'user-1', iat: now - 60, exp: now + 300 });
    expect(() => assertFreshVerifiedSession(fresh, 'user-1', now, 600)).not.toThrow();
    expect(() => assertFreshVerifiedSession(fresh, 'other-user', now, 600)).toThrow(/user/i);
    expect(() =>
      assertFreshVerifiedSession(jwt({ sub: 'user-1', iat: now - 601, exp: now + 300 }), 'user-1', now, 600),
    ).toThrow(/recent/i);
    expect(() =>
      assertFreshVerifiedSession(jwt({ sub: 'user-1', iat: now - 60, exp: now - 1 }), 'user-1', now, 600),
    ).toThrow(/expired/i);
  });

  test('lets a verified guest delete without impossible provider reauthentication', async () => {
    const verifyToken = jest.fn();
    await expect(authorizeDeletionSession({
      currentUser: { id: 'guest-1', is_anonymous: true },
      reauthenticationToken: null,
      verifyToken,
    })).resolves.toMatchObject({
      id: 'guest-1',
      is_anonymous: true,
    });
    expect(verifyToken).not.toHaveBeenCalled();

    await expect(authorizeDeletionSession({
      currentUser: { id: 'user-1', is_anonymous: false },
      reauthenticationToken: null,
      verifyToken,
    })).rejects.toThrow(/reauth/i);
  });

  test('does not mistake an automatic token refresh for user reauthentication', async () => {
    const now = Math.floor(Date.now() / 1_000);
    const refreshedOnly = jwt({
      sub: 'user-1',
      iat: now - 10,
      exp: now + 300,
      amr: [{ method: 'token_refresh', timestamp: now - 10 }],
    });
    await expect(authorizeDeletionSession({
      currentUser: { id: 'user-1', is_anonymous: false },
      reauthenticationToken: refreshedOnly,
      verifyToken: async () => ({ id: 'user-1', is_anonymous: false }),
    })).rejects.toThrow(/provider/i);

    const freshOAuth = jwt({
      sub: 'user-1',
      iat: now - 10,
      exp: now + 300,
      amr: [{ method: 'oauth', timestamp: now - 10 }],
    });
    await expect(authorizeDeletionSession({
      currentUser: { id: 'user-1', is_anonymous: false },
      reauthenticationToken: freshOAuth,
      verifyToken: async () => ({ id: 'user-1', is_anonymous: false }),
    })).resolves.toMatchObject({ id: 'user-1' });
  });

  test('uses durable deletion phases and never loses a persisted manual-revocation flag', () => {
    const authorized = normalizeDeletionProgress({
      request_id: 'request-1',
      user_id: 'user-1',
      provider_revoked_at: '2026-09-05T00:00:00Z',
      storage_cleared_at: null,
      db_cleared_at: null,
      manual_revocation_required: true,
    });
    expect(authorized).toEqual(expect.objectContaining({
      providerComplete: true,
      storageComplete: false,
      databaseComplete: false,
      manualRevocationRequired: true,
    }));
    expect(mergeDeletionProgress(authorized, {
      storage_cleared_at: '2026-09-05T00:01:00Z',
      manual_revocation_required: false,
    })).toEqual(expect.objectContaining({
      providerComplete: true,
      storageComplete: true,
      manualRevocationRequired: true,
    }));
  });

  test('maps the private authorized phase to a stable public processing status', () => {
    expect(normalizePublicDeletionStatus('authorized')).toBe('processing');
    expect(normalizePublicDeletionStatus('processing')).toBe('processing');
    expect(normalizePublicDeletionStatus('db-cleared')).toBe('db-cleared');
    expect(() => normalizePublicDeletionStatus('unknown')).toThrow(/status/i);
  });

  test('verifies a Google provider token subject and audience before revocation', async () => {
    const fetchTokenInfo = jest.fn(async () => new Response(JSON.stringify({
      sub: 'google-user-1',
      aud: 'google-client-web',
      expires_in: '120',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(verifyGoogleProviderToken(
      'provider-access-token',
      'google-user-1',
      ['google-client-ios', 'google-client-web'],
      fetchTokenInfo,
    )).resolves.toBeUndefined();
    expect(fetchTokenInfo).toHaveBeenCalledWith(
      expect.stringContaining('access_token=provider-access-token'),
      expect.objectContaining({ method: 'GET' }),
    );

    await expect(verifyGoogleProviderToken(
      'provider-access-token',
      'another-user',
      ['google-client-web'],
      fetchTokenInfo,
    )).rejects.toThrow(/identity/i);
  });

  test('revokes an exchanged Apple refresh token when identity verification fails', async () => {
    const revoke = jest.fn(async () => undefined);
    await expect(finalizeAppleTokenPayload({
      payload: { refresh_token: 'new-refresh-token', id_token: 'invalid-id-token' },
      clientId: 'com.recoto.app',
      expectedNonceHash: 'expected-hash',
      verifyIdentityToken: async () => {
        throw new Error('bad signature');
      },
      revokeRefreshToken: revoke,
    })).rejects.toThrow(/signature/i);
    expect(revoke).toHaveBeenCalledWith('new-refresh-token');
  });

  test('keeps Apple revocation retryable after network and temporary server failures', async () => {
    await expect(completeAppleTokenRevocationRequest(async () => {
      throw new TypeError('network unavailable');
    })).rejects.toMatchObject({
      name: 'AppleTokenRevocationError',
      retryable: true,
    });

    await expect(completeAppleTokenRevocationRequest(
      async () => new Response(null, { status: 503 }),
    )).rejects.toMatchObject({ retryable: true });
    await expect(completeAppleTokenRevocationRequest(
      async () => new Response(null, { status: 429 }),
    )).rejects.toMatchObject({ retryable: true });
  });

  test('treats Apple successful/already-invalid revocation as complete', async () => {
    await expect(completeAppleTokenRevocationRequest(
      async () => new Response(null, { status: 200 }),
    )).resolves.toBeUndefined();

    await expect(completeAppleTokenRevocationRequest(
      async () => new Response(JSON.stringify({ error: 'invalid_token' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )).resolves.toBeUndefined();

    await expect(completeAppleTokenRevocationRequest(
      async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )).resolves.toBeUndefined();
  });

  test.each(['invalid_client', 'unauthorized_client', 'invalid_request'])(
    'marks the terminal Apple OAuth error %s for manual revocation without blocking deletion',
    async (oauthError) => {
    await expect(completeAppleTokenRevocationRequest(
      async () => new Response(JSON.stringify({ error: oauthError }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )).rejects.toBeInstanceOf(AppleTokenRevocationError);
    await expect(completeAppleTokenRevocationRequest(
      async () => new Response(JSON.stringify({ error: oauthError }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )).rejects.toMatchObject({ retryable: false });
    },
  );

  test('keeps an interrupted Apple error response retryable', async () => {
    await expect(completeAppleTokenRevocationRequest(
      async () => new Response(new ReadableStream({
        pull(controller) {
          controller.error(new TypeError('response interrupted'));
        },
      }), { status: 400 }),
    )).rejects.toMatchObject({ retryable: true });
  });

  test('verifies Apple identity-token signature, audience, time, and nonce', async () => {
    const keys = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
    const now = 1_800_000_000;
    const header = base64Url(JSON.stringify({ alg: 'RS256', kid: 'apple-key-1' }));
    const payload = base64Url(JSON.stringify({
      iss: 'https://appleid.apple.com',
      aud: 'com.recoto.app',
      sub: 'apple-user-1',
      iat: now - 10,
      exp: now + 300,
      nonce: 'hashed-request-nonce',
    }));
    const signingInput = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      keys.privateKey,
      new TextEncoder().encode(signingInput),
    );
    const token = `${signingInput}.${base64Url(new Uint8Array(signature))}`;
    let jwksRequests = 0;
    const fetchJwks = jest.fn(async (): Promise<Response> => {
      jwksRequests += 1;
      return new Response(JSON.stringify({
      keys: jwksRequests === 1
        ? [{ ...publicJwk, kid: 'retired-key', alg: 'RS256', use: 'sig' }]
        : [{ ...publicJwk, kid: 'apple-key-1', alg: 'RS256', use: 'sig' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await expect(verifyAppleIdentityToken(token, {
      clientId: 'com.recoto.app',
      expectedNonceHash: 'hashed-request-nonce',
      nowSeconds: now,
      fetchJwks,
    })).resolves.toEqual({
      subject: 'apple-user-1',
      issuedAtSeconds: now - 10,
    });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    await expect(verifyAppleIdentityToken(token, {
      clientId: 'com.recoto.app',
      expectedNonceHash: 'wrong-nonce',
      nowSeconds: now,
      fetchJwks,
    })).rejects.toThrow(/nonce/i);

    const tampered = `${header}.${base64Url(JSON.stringify({
      iss: 'https://appleid.apple.com',
      aud: 'com.recoto.app',
      sub: 'attacker',
      iat: now - 10,
      exp: now + 300,
      nonce: 'hashed-request-nonce',
    }))}.${base64Url(new Uint8Array(signature))}`;
    await expect(verifyAppleIdentityToken(tampered, {
      clientId: 'com.recoto.app',
      expectedNonceHash: 'hashed-request-nonce',
      nowSeconds: now,
      fetchJwks,
    })).rejects.toThrow(/signature/i);
  });

  test('verifies Apple account-event JWS signature, audience, expiry, event type, and subject', async () => {
    const keys = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
    const now = 1_800_000_000;
    const sign = async (claims: Record<string, unknown>) => {
      const header = base64Url(JSON.stringify({ alg: 'RS256', kid: 'apple-events-key' }));
      const payload = base64Url(JSON.stringify(claims));
      const signingInput = `${header}.${payload}`;
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keys.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
    };
    const fetchJwks = jest.fn(async () => new Response(JSON.stringify({
      keys: [{ ...publicJwk, kid: 'apple-events-key', alg: 'RS256', use: 'sig' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const claims = {
      iss: 'https://appleid.apple.com',
      aud: 'com.herac.recoto',
      iat: now - 10,
      jti: 'apple-event-1',
      // Apple has delivered this claim as both an object and serialized JSON.
      events: JSON.stringify({
        type: 'consent-revoked',
        sub: 'apple-subject-1',
        event_time: now - 5,
      }),
    };

    await expect(verifyAppleAccountNotification(await sign(claims), {
      clientIds: ['com.herac.recoto'],
      nowSeconds: now,
      fetchJwks,
    })).resolves.toEqual({
      eventId: 'apple-event-1',
      type: 'consent-revoked',
      subject: 'apple-subject-1',
      eventTimeSeconds: now - 5,
      audience: 'com.herac.recoto',
    });

    await expect(verifyAppleAccountNotification(await sign({
      ...claims,
      aud: 'com.attacker.app',
    }), {
      clientIds: ['com.herac.recoto'], nowSeconds: now, fetchJwks,
    })).rejects.toThrow(/claims/i);
    await expect(verifyAppleAccountNotification(await sign({
      ...claims,
      exp: now - 1,
    }), {
      clientIds: ['com.herac.recoto'], nowSeconds: now, fetchJwks,
    })).rejects.toThrow(/claims/i);
    await expect(verifyAppleAccountNotification(await sign({
      ...claims,
      exp: now + 300,
    }), {
      clientIds: ['com.herac.recoto'], nowSeconds: now, fetchJwks,
    })).resolves.toMatchObject({ eventId: 'apple-event-1' });
    await expect(verifyAppleAccountNotification(await sign({
      ...claims,
      iat: now - (90 * 24 * 60 * 60) - 1,
    }), {
      clientIds: ['com.herac.recoto'], nowSeconds: now, fetchJwks,
    })).rejects.toThrow(/claims/i);
    await expect(verifyAppleAccountNotification(await sign({
      ...claims,
      events: {
        type: 'account-deleted',
        sub: 'apple-subject-1',
        event_time: (now - (90 * 24 * 60 * 60) - 1) * 1_000,
      },
    }), {
      clientIds: ['com.herac.recoto'], nowSeconds: now, fetchJwks,
    })).rejects.toThrow(/event/i);
    await expect(verifyAppleAccountNotification(await sign({
      ...claims,
      events: { type: 'email-enabled', sub: 'apple-subject-1', event_time: now - 5 },
    }), {
      clientIds: ['com.herac.recoto'], nowSeconds: now, fetchJwks,
    })).resolves.toMatchObject({ type: 'email-enabled', subject: 'apple-subject-1' });
    await expect(verifyAppleAccountNotification(await sign({
      ...claims,
      events: { type: 'unknown-event', sub: 'apple-subject-1', event_time: now - 5 },
    }), {
      clientIds: ['com.herac.recoto'], nowSeconds: now, fetchJwks,
    })).rejects.toThrow(/event/i);
    await expect(verifyAppleAccountNotification(await sign({
      ...claims,
      events: { type: 'account-deleted', sub: '', event_time: now - 5 },
    }), {
      clientIds: ['com.herac.recoto'], nowSeconds: now, fetchJwks,
    })).rejects.toThrow(/event/i);
  });
});

describe('account lifecycle Edge Function contracts', () => {
  const functionNames = [
    'start-account-merge',
    'complete-account-merge',
    'cancel-account-merge',
    'start-account-deletion',
    'store-apple-token',
    'apple-credential-status',
    'delete-account',
  ];

  test.each(functionNames)('%s uses the shared guarded handler', (name) => {
    const source = read(`${name}/index.ts`);
    expect(source).toContain('serveAccountFunction');
    expect(source).not.toMatch(/Access-Control-Allow-Origin['"]?\s*:\s*['"]\*/);
    expect(source).not.toMatch(/console\.(?:log|info|debug)\s*\(/);
  });

  test('deletion status uses a receipt secret instead of an already-deleted Auth session', () => {
    const source = read('account-deletion-status/index.ts');
    expect(source).toContain('servePublicAccountFunction');
    expect(source).toContain('get_account_deletion_status');
    expect(source).toContain('receiptSecret');
    expect(source).not.toContain('Authorization');
    expect(source).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  test('keeps JWT verification on for account endpoints and explicitly permits receipt recovery', () => {
    const config = fs.readFileSync(path.join(ROOT, 'supabase/config.toml'), 'utf8');
    expect(config).toMatch(/\[functions\.account-deletion-status\]\s+verify_jwt\s*=\s*false/);
    expect(config).toMatch(/\[functions\.apple-account-notification\]\s+verify_jwt\s*=\s*false/);
    for (const name of functionNames) {
      expect(config).not.toMatch(new RegExp(
        `\\[functions\\.${name}\\]\\s+verify_jwt\\s*=\\s*false`,
      ));
    }
  });

  test('the runtime verifies bearer JWTs and keeps service credentials server-only', () => {
    const runtime = read('_shared/runtime.ts');
    expect(runtime).toContain("requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY')");
    expect(runtime).toContain("requiredEnvironment('SUPABASE_ANON_KEY')");
    expect(runtime).toMatch(/function requiredEnvironment[\s\S]*?Deno\.env\.get\(name\)/);
    expect(runtime).toMatch(/auth\.getUser\(token\)/);
    expect(runtime).not.toMatch(/EXPO_PUBLIC_.*SERVICE_ROLE/);

    const publicFiles = ['app.json', 'package.json', 'lib/supabase.ts']
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n');
    expect(publicFiles).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(publicFiles).not.toContain('APPLE_PRIVATE_KEY');
    expect(publicFiles).not.toContain('APPLE_TOKEN_ENCRYPTION_KEY');
  });

  test('merge identity is derived from verified sessions and the one-time nonce', () => {
    const start = read('start-account-merge/index.ts');
    const complete = read('complete-account-merge/index.ts');
    const cancel = read('cancel-account-merge/index.ts');

    expect(start).toContain('context.user.id');
    expect(start).toContain('create_account_merge_intent');
    expect(start).not.toContain('body.sourceUserId');

    expect(complete).toContain('context.user.id');
    expect(complete).toContain('consume_account_merge_intent');
    expect(complete).toContain('merge_account_data');
    expect(complete).toContain('intent.source_user_id');
    expect(complete).not.toContain('body.sourceUserId');
    const copyIndex = complete.indexOf('copyUserStorageObjects(', complete.indexOf('serveAccountFunction'));
    const mergeIndex = complete.indexOf("rpc('merge_account_data'");
    const sourceCleanupIndex = complete.indexOf(
      'deleteUserStorageObjects(context.adminClient, intent.source_user_id)',
    );
    const sourceAuthDeleteIndex = complete.indexOf('deleteUser(intent.source_user_id');
    expect(copyIndex).toBeGreaterThanOrEqual(0);
    expect(mergeIndex).toBeGreaterThan(copyIndex);
    expect(sourceCleanupIndex).toBeGreaterThan(mergeIndex);
    expect(sourceAuthDeleteIndex).toBeGreaterThan(sourceCleanupIndex);
    expect(complete).toContain('p_media_copied: true');

    expect(cancel).toContain('context.user.id');
    expect(cancel).toContain('cancel_account_merge_intent');
  });

  test('Apple authorization codes are exchanged once and refresh tokens are encrypted', () => {
    const source = read('store-apple-token/index.ts');
    const apple = read('_shared/apple.ts');
    const appleIdentity = read('_shared/appleIdentity.ts');

    expect(source).toContain('exchangeAppleAuthorizationCode');
    expect(source).toContain('encryptAppleRefreshToken');
    expect(source).toContain('begin_apple_credential_store');
    expect(source).toContain('mark_apple_credential_exchange_started');
    expect(source).toContain('complete_apple_credential_store');
    expect(source.indexOf("rpc('begin_apple_credential_store'")).toBeLessThan(
      source.indexOf("rpc('mark_apple_credential_exchange_started'"),
    );
    expect(source.indexOf("rpc('mark_apple_credential_exchange_started'")).toBeLessThan(
      source.indexOf('await exchangeAppleAuthorizationCode'),
    );
    expect(source).toContain("claim.data === 'uncertain'");
    expect(source).toContain('apple_credential_store_repair_required');
    expect(source).toContain('reconcile_apple_credential_store');
    expect(source).toContain('p_provider_revocation_confirmed: true');
    expect(source).not.toMatch(
      /rpc\('reconcile_apple_credential_store'[\s\S]*?\}\)\.catch\(/,
    );
    expect(source).toMatch(
      /try\s*\{[\s\S]*?await context\.adminClient\.rpc\('reconcile_apple_credential_store'[\s\S]*?\}\s*catch\s*\{/,
    );
    expect(source).toContain('p_credential_issued_at');
    expect(source).toContain('expectedNonceHash');
    expect(source).toContain('revokeAppleRefreshToken(tokens.refreshToken)');
    expect(source).not.toMatch(/refreshToken\s*:/);
    expect(apple).toContain('AES-GCM');
    expect(apple).toContain('ES256');
    expect(appleIdentity).toContain('RS256');
    expect(apple).toContain('APPLE_TOKEN_ENCRYPTION_KEYS_JSON');
    expect(appleIdentity).toContain('https://appleid.apple.com/auth/keys');
    expect(apple).toContain('https://appleid.apple.com/auth/token');
  });

  test('Apple credential recovery exposes only a subject-bound boolean', () => {
    const source = read('apple-credential-status/index.ts');

    expect(source).toContain("providerSubject(context.user, 'apple')");
    expect(source).toContain('appleSubjectHash(subject)');
    expect(source).toContain("rpc('has_apple_credential'");
    expect(source).toContain('hasCredential: response.data');
    expect(source).not.toContain('encrypted_refresh_token');
    expect(source).not.toContain('ciphertextBase64');
  });

  test('account deletion verifies fresh reauthentication and deletes server data before Auth', () => {
    const source = read('delete-account/index.ts');
    const resumeIndex = source.indexOf('resume_account_deletion');
    const reauthIndex = source.lastIndexOf('verifyDeletionAuthorization');
    const requestIndex = source.indexOf('authorize_account_deletion');
    const googleRevocationIndex = source.lastIndexOf('revokeGoogleProviderToken');
    const storageIndex = source.lastIndexOf('deleteUserStorageObjects');
    const finalizeIndex = source.indexOf('finalize_account_deletion');
    const authDeleteIndex = source.indexOf('deleteUser(context.user.id');

    expect(source).toContain('verifyDeletionAuthorization');
    expect(source).toContain('resume_account_deletion');
    expect(source).toContain('authorize_account_deletion');
    expect(source).toContain('mark_account_deletion_phase');
    expect(source).toContain('complete_account_deletion_receipt');
    expect(source).toContain('normalizeDeletionProgress');
    expect(source).toMatch(/if \(!progress\.providerComplete\)/);
    expect(source).toMatch(/if \(!progress\.storageComplete\)/);
    expect(source).toMatch(/if \(!progress\.databaseComplete\)/);
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(reauthIndex).toBeGreaterThan(resumeIndex);
    expect(requestIndex).toBeGreaterThan(reauthIndex);
    expect(googleRevocationIndex).toBeGreaterThan(reauthIndex);
    expect(requestIndex).toBeGreaterThan(googleRevocationIndex);
    expect(source).toContain('p_google_revocation_handled');
    expect(source).toContain('p_manual_revocation_required');
    expect(source).toContain('google_revocation_handled_at');
    expect(storageIndex).toBeGreaterThan(requestIndex);
    expect(finalizeIndex).toBeGreaterThan(storageIndex);
    expect(authDeleteIndex).toBeGreaterThan(finalizeIndex);
    expect(source).toContain('revokeAppleRefreshToken');
    expect(source).toMatch(
      /error instanceof AppleTokenRevocationError\s*&&\s*error\.retryable[\s\S]*?throw error/,
    );
    expect(source).toContain('mark_account_deletion_failed');
    expect(source).not.toContain('body.userId');
  });

  test('Apple account notifications verify first and reuse the deletion phases idempotently', () => {
    const source = read('apple-account-notification/index.ts');
    const verifyIndex = source.indexOf('verifyAppleAccountNotification');
    const beginIndex = source.indexOf("rpc('begin_apple_account_event'");
    const storageIndex = source.lastIndexOf('deleteUserStorageObjects');
    const finalizeIndex = source.indexOf("rpc('finalize_account_deletion'");
    const authDeleteIndex = source.indexOf('deleteUser(userId');
    const completeIndex = source.indexOf("rpc('complete_apple_account_event'");

    expect(source).toContain('servePublicAccountFunction');
    expect(source).toContain("requireString(context.body, 'payload'");
    expect(source).toContain('appleSubjectHash(notification.subject)');
    expect(source).toMatch(
      /notification\.type === 'email-enabled'[\s\S]*?return \{ received: true, ignored: true \}/,
    );
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeGreaterThan(verifyIndex);
    expect(storageIndex).toBeGreaterThan(beginIndex);
    expect(finalizeIndex).toBeGreaterThan(storageIndex);
    expect(authDeleteIndex).toBeGreaterThan(finalizeIndex);
    expect(completeIndex).toBeGreaterThan(authDeleteIndex);
    expect(source).not.toMatch(/console\.(?:log|info|debug)\s*\(/);
    expect(source).not.toContain('body.userId');
    expect(source).not.toContain('notification.subject,');
  });
});
