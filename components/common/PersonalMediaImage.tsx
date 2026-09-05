import React from 'react';
import { Image, type ImageProps } from 'react-native';
import { usePersonalMediaUri } from '../../hooks/usePersonalMediaUri';
import type { PersonalMediaDomain } from '../../lib/account/personalMedia';

type Props = Omit<ImageProps, 'source'> & {
  uri: string | undefined;
  domain: PersonalMediaDomain | readonly PersonalMediaDomain[];
};

/** Image boundary for private owner-scoped media keys and local picker URIs. */
export function PersonalMediaImage({ uri, domain, ...props }: Props) {
  const resolvedUri = usePersonalMediaUri(uri, domain);
  if (!resolvedUri || resolvedUri.startsWith('icon://')) return null;
  return <Image {...props} source={{ uri: resolvedUri }} />;
}
