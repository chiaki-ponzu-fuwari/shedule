import fs from 'node:fs';
import path from 'node:path';

test('callback route delegates to the journal consumer without exchanging on the main client', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'app/auth/callback.tsx'),
    'utf8',
  );

  expect(source).toContain("consumeOAuthCallback(incomingUrl, 'route')");
  expect(source).toContain('Linking.useURL()');
  expect(source).not.toContain('completeAccountOAuthCallback');
  expect(source).not.toContain('getSupabaseClient');
  expect(source).not.toContain('callbackUrlFromParams');
});

test('web callback durably inboxes the exact URL before notifying the opener', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'app/auth/callback.tsx'),
    'utf8',
  );

  expect(source).toContain('window.location.href');
  expect(source).toContain('inboxAccountOAuthCallback');
  expect(source).toContain('getAccountOAuthOperationJournal');
  expect(source).toMatch(
    /await inboxAccountOAuthCallback\([\s\S]*completion = WebBrowser\.maybeCompleteAuthSession\(/,
  );
  expect(source).not.toMatch(/const browserCompletion\s*=\s*[\s\S]*maybeCompleteAuthSession/);
});

test('root layout mounts the journal-aware callback before owner bootstrap gates', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'app/_layout.tsx'), 'utf8');
  expect(source).toContain('usePathname');
  expect(source).toMatch(/pathname === ['"]\/auth\/callback['"]/);
  expect(source).toContain('<ApplicationStack />');
});
