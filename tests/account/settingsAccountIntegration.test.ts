import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

test('places backup account settings separately from Google Calendar access', () => {
  const settings = fs.readFileSync(path.join(root, 'app/(tabs)/settings.tsx'), 'utf8');
  const messages = fs.readFileSync(path.join(root, 'constants/i18n.ts'), 'utf8');

  expect(settings).toContain("import { AccountBackupCard } from '../../components/settings/AccountBackupCard'");
  expect(settings.indexOf('<AccountBackupCard />')).toBeGreaterThan(0);
  expect(settings.indexOf('<AccountBackupCard />')).toBeLessThan(
    settings.indexOf('{/* Google Calendar sync'),
  );
  expect(messages).toContain("'settings.google': 'Googleカレンダー連携'");

  const accountCard = fs.readFileSync(
    path.join(root, 'components/settings/AccountBackupCard.tsx'),
    'utf8',
  );
  expect(accountCard).toContain('<AccountDeletionControl');
});

test('registers the PKCE callback route in the root stack', () => {
  const layout = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
  expect(layout).toContain('<Stack.Screen name="auth/callback" />');
});
