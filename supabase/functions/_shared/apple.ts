import {
  base64ToBytes,
  bytesToBase64,
  bytesToBase64Url,
  pemPkcs8Bytes,
  sha256Hex,
  utf8ToBase64Url,
} from './crypto.ts';
import { verifyAppleIdentityToken } from './appleIdentity.ts';
import {
  finalizeAppleTokenPayload,
  type AppleTokenSet,
} from './appleTokenPayload.ts';
import { completeAppleTokenRevocationRequest } from './appleRevocation.ts';

const APPLE_AUDIENCE = 'https://appleid.apple.com';

type AppleEnvironment = {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  encryptionKeys: Record<string, string>;
  encryptionKeyId: string;
};

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing Apple server environment: ${name}`);
  return value;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function appleEnvironment(): AppleEnvironment {
  const encryptionKeyId = required('APPLE_TOKEN_ENCRYPTION_KEY_ID');
  const encryptionKeys: Record<string, string> = {};
  const serializedKeyring = Deno.env.get('APPLE_TOKEN_ENCRYPTION_KEYS_JSON')?.trim();
  if (serializedKeyring) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serializedKeyring);
    } catch {
      throw new Error('Apple encryption keyring is invalid');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Apple encryption keyring is invalid');
    }
    for (const [keyId, value] of Object.entries(parsed)) {
      if (keyId && typeof value === 'string' && value) encryptionKeys[keyId] = value;
    }
  }
  const legacyActiveKey = Deno.env.get('APPLE_TOKEN_ENCRYPTION_KEY_BASE64')?.trim();
  if (legacyActiveKey && !encryptionKeys[encryptionKeyId]) {
    encryptionKeys[encryptionKeyId] = legacyActiveKey;
  }
  if (!encryptionKeys[encryptionKeyId]) {
    throw new Error('Apple active encryption key is missing from the keyring');
  }
  return {
    clientId: required('APPLE_CLIENT_ID'),
    teamId: required('APPLE_TEAM_ID'),
    keyId: required('APPLE_KEY_ID'),
    privateKey: required('APPLE_PRIVATE_KEY'),
    encryptionKeys,
    encryptionKeyId,
  };
}

async function appleClientSecret(environment: AppleEnvironment): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = utf8ToBase64Url(JSON.stringify({ alg: 'ES256', kid: environment.keyId }));
  const payload = utf8ToBase64Url(JSON.stringify({
    iss: environment.teamId,
    iat: now,
    exp: now + 5 * 60,
    aud: APPLE_AUDIENCE,
    sub: environment.clientId,
  }));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    asArrayBuffer(pemPkcs8Bytes(environment.privateKey)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    asArrayBuffer(new TextEncoder().encode(signingInput)),
  ));
  return `${signingInput}.${bytesToBase64Url(signature)}`;
}

async function postAppleTokenForm(parameters: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: parameters,
    signal: AbortSignal.timeout(10_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Apple token exchange failed');
  }
  return payload as Record<string, unknown>;
}

export async function exchangeAppleAuthorizationCode(
  authorizationCode: string,
  expectedNonceHash: string,
): Promise<AppleTokenSet> {
  const environment = appleEnvironment();
  const payload = await postAppleTokenForm(new URLSearchParams({
    client_id: environment.clientId,
    client_secret: await appleClientSecret(environment),
    code: authorizationCode,
    grant_type: 'authorization_code',
  }));
  return finalizeAppleTokenPayload({
    payload,
    clientId: environment.clientId,
    expectedNonceHash,
    verifyIdentityToken: verifyAppleIdentityToken,
    revokeRefreshToken: revokeAppleRefreshToken,
  });
}

export type { AppleTokenSet };

async function aesKey(encryptionKeyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(encryptionKeyBase64);
  if (raw.byteLength !== 32) throw new Error('Apple encryption key must be 256 bits');
  return crypto.subtle.importKey(
    'raw',
    asArrayBuffer(raw),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptAppleRefreshToken(
  refreshToken: string,
): Promise<{ ciphertextBase64: string; encryptionKeyId: string }> {
  const environment = appleEnvironment();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(iv) },
    await aesKey(environment.encryptionKeys[environment.encryptionKeyId]),
    asArrayBuffer(new TextEncoder().encode(refreshToken)),
  ));
  const envelope = new Uint8Array(1 + iv.byteLength + ciphertext.byteLength);
  envelope[0] = 1;
  envelope.set(iv, 1);
  envelope.set(ciphertext, 1 + iv.byteLength);
  return {
    ciphertextBase64: bytesToBase64(envelope),
    encryptionKeyId: environment.encryptionKeyId,
  };
}

export async function decryptAppleRefreshToken(
  ciphertextBase64: string,
  encryptionKeyId: string,
): Promise<string> {
  const environment = appleEnvironment();
  const encryptionKey = environment.encryptionKeys[encryptionKeyId];
  if (!encryptionKey) throw new Error('Apple encryption key is unavailable');
  const envelope = base64ToBytes(ciphertextBase64);
  if (envelope.byteLength < 30 || envelope[0] !== 1) throw new Error('Apple token envelope is invalid');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(envelope.slice(1, 13)) },
    await aesKey(encryptionKey),
    asArrayBuffer(envelope.slice(13)),
  );
  return new TextDecoder().decode(plaintext);
}

export async function appleSubjectHash(subject: string): Promise<string> {
  return sha256Hex(subject);
}

export async function revokeAppleRefreshToken(refreshToken: string): Promise<void> {
  const environment = appleEnvironment();
  const clientSecret = await appleClientSecret(environment);
  await completeAppleTokenRevocationRequest(() => fetch(
    'https://appleid.apple.com/auth/revoke',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: environment.clientId,
        client_secret: clientSecret,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
      signal: AbortSignal.timeout(10_000),
    },
  ));
}
