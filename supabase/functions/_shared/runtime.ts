import { createClient, type SupabaseClient, type User } from './deps.ts';
import {
  EdgeRequestError,
  parseBearerToken,
  parseBoundedJsonObject,
  validateWebOrigin,
} from './requestSecurity.ts';
import { readBoundedRequestBody } from './boundedBody.ts';
import { createCorsHeaders } from './http.ts';

export interface AccountFunctionContext {
  request: Request;
  body: Record<string, unknown>;
  token: string;
  user: User;
  userClient: SupabaseClient;
  adminClient: SupabaseClient;
}

export interface PublicAccountFunctionContext {
  request: Request;
  body: Record<string, unknown>;
  adminClient: SupabaseClient;
}

type AccountFunctionHandler = (
  context: AccountFunctionContext,
) => Promise<Record<string, unknown> | Response>;

type PublicAccountFunctionHandler = (
  context: PublicAccountFunctionContext,
) => Promise<Record<string, unknown> | Response>;

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing server environment: ${name}`);
  return value;
}

function allowedOrigins(): string[] {
  return (Deno.env.get('ALLOWED_WEB_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: createCorsHeaders(origin),
  });
}

async function verifiedContext(
  request: Request,
  body: Record<string, unknown>,
): Promise<AccountFunctionContext> {
  const token = parseBearerToken(request.headers.get('Authorization'));
  const url = requiredEnvironment('SUPABASE_URL');
  const anonKey = requiredEnvironment('SUPABASE_ANON_KEY');
  const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const verified = await userClient.auth.getUser(token);
  if (verified.error || !verified.data.user?.id) {
    throw new EdgeRequestError(401, 'invalid_session', 'The account session is invalid');
  }

  const adminClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    request,
    body,
    token,
    user: verified.data.user,
    userClient,
    adminClient,
  };
}

function safeError(error: unknown, origin: string | null): Response {
  if (error instanceof EdgeRequestError) {
    return jsonResponse({ error: { code: error.code, message: error.message } }, error.status, origin);
  }
  // Do not expose provider, SQL, token, or credential details to clients.
  return jsonResponse(
    {
      error: {
        code: 'temporarily_unavailable',
        message: 'The account service is temporarily unavailable. Please retry.',
      },
    },
    503,
    origin,
  );
}

export function serveAccountFunction(handler: AccountFunctionHandler): void {
  Deno.serve(async (request) => {
    let origin: string | null = null;
    try {
      origin = validateWebOrigin(request.headers.get('Origin'), allowedOrigins());
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: createCorsHeaders(origin) });
      }
      if (request.method !== 'POST') {
        throw new EdgeRequestError(405, 'method_not_allowed', 'POST is required');
      }

      const body = parseBoundedJsonObject(await readBoundedRequestBody(request));
      const result = await handler(await verifiedContext(request, body));
      return result instanceof Response ? result : jsonResponse(result, 200, origin);
    } catch (error) {
      return safeError(error, origin);
    }
  });
}

/**
 * Public lifecycle recovery endpoints cannot require the deleted user's JWT.
 * They authenticate the request with a high-entropy, one-way-hashed receipt
 * secret in their RPC. The service-role client remains confined to this
 * server-only runtime.
 */
export function servePublicAccountFunction(handler: PublicAccountFunctionHandler): void {
  Deno.serve(async (request) => {
    let origin: string | null = null;
    try {
      origin = validateWebOrigin(request.headers.get('Origin'), allowedOrigins());
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: createCorsHeaders(origin) });
      }
      if (request.method !== 'POST') {
        throw new EdgeRequestError(405, 'method_not_allowed', 'POST is required');
      }

      const body = parseBoundedJsonObject(await readBoundedRequestBody(request));
      const url = requiredEnvironment('SUPABASE_URL');
      const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
      const adminClient = createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const result = await handler({ request, body, adminClient });
      return result instanceof Response ? result : jsonResponse(result, 200, origin);
    } catch (error) {
      return safeError(error, origin);
    }
  });
}

export function rpcDataRecord(data: unknown, operation: string): Record<string, unknown> {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${operation} returned no record`);
  }
  return value as Record<string, unknown>;
}

export function rpcError(error: { message?: string; code?: string } | null): void {
  if (error) throw new Error(`Database operation failed: ${error.code ?? 'unknown'}`);
}
