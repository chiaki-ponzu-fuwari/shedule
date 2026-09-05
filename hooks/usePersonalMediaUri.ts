import type { SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import {
  createSupabasePersonalMediaStorage,
  SIGNED_MEDIA_TTL_SECONDS,
  type PersonalMediaDomain,
} from '../lib/account/personalMedia';
import {
  createPersonalMediaReadUrlResolver,
} from '../lib/account/productionPersonalMedia';
import {
  isDevicePersonalMediaUri,
  parsePersonalMediaObjectKey,
} from '../lib/account/personalMediaSync';
import { getSupabaseClient } from '../lib/supabase';
import { useAccountStore } from '../store/accountStore';

type Resolver = ReturnType<typeof createPersonalMediaReadUrlResolver>;

const resolvers = new WeakMap<SupabaseClient, Map<string, Resolver>>();

function resolverFor(client: SupabaseClient, ownerId: string): Resolver {
  let byOwner = resolvers.get(client);
  if (!byOwner) {
    byOwner = new Map();
    resolvers.set(client, byOwner);
  }
  const existing = byOwner.get(ownerId);
  if (existing) return existing;
  const storage = createSupabasePersonalMediaStorage(client);
  const resolver = createPersonalMediaReadUrlResolver({
    ownerId,
    createSignedReadUrl: async (selectedOwnerId, domain, objectKey) => {
      const parsed = parsePersonalMediaObjectKey(objectKey, selectedOwnerId);
      if (!parsed || parsed.domain !== domain) {
        throw new Error('Invalid private personal media reference');
      }
      return storage.createSignedUrl(objectKey, SIGNED_MEDIA_TTL_SECONDS);
    },
  });
  byOwner.set(ownerId, resolver);
  return resolver;
}

interface Resolution {
  identity: string;
  uri?: string;
}

/** Returns a local URI immediately or a short-lived URL for a strict private key. */
export function usePersonalMediaUri(
  sourceUri: string | undefined,
  expectedDomain: PersonalMediaDomain | readonly PersonalMediaDomain[],
): string | undefined {
  const mode = useAccountStore((state) => state.mode);
  const ownerId = useAccountStore((state) => state.userId);
  const [resolution, setResolution] = useState<Resolution>({ identity: '' });

  const isLocal = Boolean(sourceUri) && (
    sourceUri!.startsWith('icon://') || isDevicePersonalMediaUri(sourceUri)
  );
  const allowedDomains = typeof expectedDomain === 'string'
    ? [expectedDomain]
    : expectedDomain;
  const domainKey = allowedDomains.join(',');
  const parsed = isLocal ? null : parsePersonalMediaObjectKey(sourceUri, ownerId ?? undefined);
  const identity = mode === 'account-connected' && ownerId && parsed
    && allowedDomains.includes(parsed.domain)
    ? `${ownerId}\u0000${domainKey}\u0000${sourceUri}`
    : '';

  useEffect(() => {
    if (!identity || !ownerId || !sourceUri) return;
    const client = getSupabaseClient();
    if (!client) return;
    let active = true;
    void resolverFor(client, ownerId).resolve(sourceUri, allowedDomains).then((uri) => {
      if (active) setResolution({ identity, uri });
    }).catch(() => {
      if (active) setResolution({ identity });
    });
    return () => {
      active = false;
    };
  }, [domainKey, identity, ownerId, sourceUri]);

  if (isLocal) return sourceUri;
  // Scope the cache to both owner and key so an account switch cannot display
  // the previous owner's signed URL even for a single render.
  return resolution.identity === identity ? resolution.uri : undefined;
}
