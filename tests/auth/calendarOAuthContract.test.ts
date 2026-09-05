import fs from 'node:fs';

test('does not pass removed useProxy options to Expo AuthSession', () => {
  const files = [
    'hooks/useGoogleAuth.ts',
    'hooks/useGoogleAuth.web.ts',
    'hooks/useGoogleAuth.native.ts',
    'app/(tabs)/settings.tsx',
  ];
  for (const file of files) {
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/\buseProxy\b/);
  }
});

test('keeps the currently registered web Calendar OAuth path', () => {
  const web = fs.readFileSync('hooks/useGoogleAuth.web.ts', 'utf8');
  expect(web).toMatch(/makeRedirectUri\(\{\s*path:\s*['"]auth['"]\s*\}\)/);
});
