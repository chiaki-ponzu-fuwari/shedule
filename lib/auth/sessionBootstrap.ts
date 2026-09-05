export type IdentityMode =
  | 'hydrating'
  | 'guest-local'
  | 'guest-connected'
  | 'account-connected'
  | 'deletion-pending';

export type CloudAvailability = 'unknown' | 'online' | 'offline' | 'misconfigured';

export function isGroupIdentityConnected(identityMode: IdentityMode) {
  return identityMode === 'guest-connected' || identityMode === 'account-connected';
}

type BootstrapInput = {
  configured: boolean;
  user: { id: string; is_anonymous?: boolean } | null;
};

export function decideInitialSession(input: BootstrapInput) {
  if (!input.configured) {
    return {
      identityMode: 'guest-local' as const,
      cloudAvailability: 'misconfigured' as const,
      userId: null,
    };
  }

  if (!input.user) {
    return {
      identityMode: 'guest-local' as const,
      cloudAvailability: 'online' as const,
      userId: null,
    };
  }

  return {
    identityMode: input.user.is_anonymous
      ? ('guest-connected' as const)
      : ('account-connected' as const),
    cloudAvailability: 'online' as const,
    userId: input.user.id,
  };
}

export function shouldCreateAnonymousSession(
  reason: 'app-launch' | 'group-action' | 'account-link'
) {
  return reason !== 'app-launch';
}
