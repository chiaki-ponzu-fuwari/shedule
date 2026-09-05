import fs from 'node:fs';
import path from 'node:path';

import { buildLegalLinks } from '../../lib/legalLinks';

const ROOT = path.resolve(__dirname, '../..');

describe('in-app review and legal links', () => {
  test('builds only same-origin HTTPS legal pages', () => {
    expect(buildLegalLinks('https://legal.recoto.example/')).toEqual({
      privacy: 'https://legal.recoto.example/privacy.html',
      terms: 'https://legal.recoto.example/terms.html',
      community: 'https://legal.recoto.example/community-guidelines.html',
      support: 'https://legal.recoto.example/support.html',
      deletion: 'https://legal.recoto.example/delete-account.html',
    });
    expect(() => buildLegalLinks('http://legal.recoto.example')).toThrow(/HTTPS/i);
    expect(() => buildLegalLinks('https://user:secret@legal.recoto.example')).toThrow(/credentials/i);
  });

  test('Settings exposes policy and support links while native hides unfinished Calendar OAuth', () => {
    const settings = fs.readFileSync(path.join(ROOT, 'app/(tabs)/settings.tsx'), 'utf8');
    expect(settings).toContain('<LegalLinksCard />');
    expect(settings).toMatch(/Platform\.OS === 'web'[\s\S]*?settings\.google/);
  });

  test('release-facing copy contains no developer environment setup instructions', () => {
    const messages = fs.readFileSync(path.join(ROOT, 'constants/i18n.ts'), 'utf8');
    expect(messages).not.toMatch(/\.env|EXPO_PUBLIC_GOOGLE_|Dev Client|Expo Go/);
  });
});
