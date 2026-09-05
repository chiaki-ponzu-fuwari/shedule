import type {
  AccountDeletionGateway,
  AccountDeletionStatus,
} from './accountDeletion';

export interface AccountDeletionFunctionClient {
  auth: {
    getUser(): Promise<{
      data: { user: { id: string } | null };
      error: unknown;
    }>;
  };
  functions: {
    invoke(
      name: string,
      options?: { body?: Record<string, unknown> },
    ): Promise<{ data: unknown; error: unknown }>;
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The account deletion service returned an invalid response');
  }
  return value as Record<string, unknown>;
}

async function invoke(
  client: AccountDeletionFunctionClient,
  name: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.functions.invoke(name, { body });
  if (response.error) {
    throw new Error('The account deletion service is temporarily unavailable');
  }
  return record(response.data);
}

async function verifyOwner(
  client: AccountDeletionFunctionClient,
  expectedOwnerId: string,
): Promise<void> {
  const verified = await client.auth.getUser();
  if (verified.error || verified.data.user?.id !== expectedOwnerId) {
    throw new Error('The current session does not match the verified account');
  }
}

function requestIdFrom(
  response: Record<string, unknown>,
  expectedRequestId: string,
): string {
  if (response.requestId !== expectedRequestId) {
    throw new Error('The account deletion service returned an invalid response');
  }
  return expectedRequestId;
}

export function createSupabaseAccountDeletionGateway(
  client: AccountDeletionFunctionClient,
): AccountDeletionGateway {
  return {
    async start(input) {
      await verifyOwner(client, input.ownerId);
      const response = await invoke(client, 'start-account-deletion', {
        requestId: input.requestId,
        receiptSecret: input.receiptSecret,
      });
      const requestId = requestIdFrom(response, input.requestId);
      if (typeof response.expiresAt !== 'string' || !response.expiresAt) {
        throw new Error('The account deletion service returned an invalid response');
      }
      return { requestId, expiresAt: response.expiresAt };
    },

    async deleteAccount(input) {
      await verifyOwner(client, input.ownerId);
      const response = await invoke(client, 'delete-account', {
        requestId: input.requestId,
        receiptSecret: input.receiptSecret,
        ...(input.reauthenticationToken
          ? { reauthenticationToken: input.reauthenticationToken }
          : {}),
        ...(input.googleProviderToken
          ? { googleProviderToken: input.googleProviderToken }
          : {}),
      });
      const requestId = requestIdFrom(response, input.requestId);
      if (
        response.deleted !== true
        || typeof response.manualRevocationRequired !== 'boolean'
      ) {
        throw new Error('The account deletion service returned an invalid response');
      }
      return {
        deleted: true,
        requestId,
        manualRevocationRequired: response.manualRevocationRequired,
      };
    },

    async status(input) {
      // This endpoint intentionally uses only the high-entropy receipt. It must
      // continue to work after Auth has already removed the user's session.
      const response = await invoke(client, 'account-deletion-status', {
        requestId: input.requestId,
        receiptSecret: input.receiptSecret,
      });
      const requestId = requestIdFrom(response, input.requestId);
      const statuses: AccountDeletionStatus['status'][] = [
        'challenged',
        'processing',
        'db-cleared',
        'completed',
        'failed',
      ];
      if (
        !statuses.includes(response.status as AccountDeletionStatus['status'])
        || typeof response.manualRevocationRequired !== 'boolean'
        || typeof response.retryable !== 'boolean'
      ) {
        throw new Error('The account deletion service returned an invalid response');
      }
      return {
        requestId,
        status: response.status as AccountDeletionStatus['status'],
        manualRevocationRequired: response.manualRevocationRequired,
        retryable: response.retryable,
      };
    },
  };
}
