import { appleSubjectHash } from '../_shared/apple.ts';
import { providerSubject } from '../_shared/account.ts';
import { rpcError, serveAccountFunction } from '../_shared/runtime.ts';

serveAccountFunction(async (context) => {
  const subject = providerSubject(context.user, 'apple');
  if (!subject) return { hasIdentity: false, hasCredential: false };

  const response = await context.adminClient.rpc('has_apple_credential', {
    p_user_id: context.user.id,
    p_provider_subject_hash: await appleSubjectHash(subject),
  });
  rpcError(response.error);
  if (typeof response.data !== 'boolean') {
    throw new Error('Apple credential status was invalid');
  }
  return { hasIdentity: true, hasCredential: response.data };
});
