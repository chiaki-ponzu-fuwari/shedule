import { encodeDeletionSecret } from '../../lib/account/accountDeletion';
import { accountDeletionNeedsNativeNotificationCleanup } from '../../lib/account/accountDeletionCleanup';
import fs from 'node:fs';

describe('production account deletion credentials', () => {
  test('encodes 256 random bits as an unpadded 43-character base64url secret', () => {
    const encoded = encodeDeletionSecret(Uint8Array.from({ length: 32 }, (_, index) => index));
    expect(encoded).toHaveLength(43);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('=');
  });

  test('refuses receipt material below the server security floor', () => {
    expect(() => encodeDeletionSecret(new Uint8Array(31))).toThrow(/entropy/i);
  });

  test('skips the unavailable native notification API on web', () => {
    expect(accountDeletionNeedsNativeNotificationCleanup('web')).toBe(false);
    expect(accountDeletionNeedsNativeNotificationCleanup('ios')).toBe(true);
    expect(accountDeletionNeedsNativeNotificationCleanup('android')).toBe(true);
  });

  test('requests deletion-scoped reauthentication so Apple storage repair cannot block deletion', () => {
    const source = fs.readFileSync('lib/account/productionAccountDeletionController.ts', 'utf8');
    expect(source).toMatch(
      /reauthenticate\(provider, ownerId, \{[\s\S]*?purpose: 'account-deletion'/,
    );
  });
});
