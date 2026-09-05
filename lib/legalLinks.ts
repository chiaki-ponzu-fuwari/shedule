export interface LegalLinks {
  privacy: string;
  terms: string;
  community: string;
  support: string;
  deletion: string;
}

export function buildLegalLinks(baseUrl: string): LegalLinks {
  let base: URL;
  try {
    base = new URL(baseUrl.trim());
  } catch {
    throw new Error('Legal base URL is invalid');
  }
  if (base.protocol !== 'https:') throw new Error('Legal links require HTTPS');
  if (base.username || base.password) throw new Error('Legal URL credentials are not allowed');
  if (base.search || base.hash) throw new Error('Legal base URL cannot contain a query or fragment');

  const prefix = base.pathname.replace(/\/+$/, '');
  const page = (name: string) => {
    const url = new URL(base.origin);
    url.pathname = `${prefix}/${name}`.replace(/\/{2,}/g, '/');
    return url.toString();
  };

  return {
    privacy: page('privacy.html'),
    terms: page('terms.html'),
    community: page('community-guidelines.html'),
    support: page('support.html'),
    deletion: page('delete-account.html'),
  };
}

export function configuredLegalLinks(): LegalLinks | null {
  const value = process.env.EXPO_PUBLIC_LEGAL_BASE_URL?.trim();
  if (!value) return null;
  try {
    return buildLegalLinks(value);
  } catch {
    return null;
  }
}
