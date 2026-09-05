import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const PUBLIC = path.join(ROOT, 'legal-site/public');
const requiredPages = [
  'index',
  'privacy',
  'terms',
  'support',
  'delete-account',
  'community-guidelines',
] as const;

function page(name: typeof requiredPages[number]): string {
  return fs.readFileSync(path.join(PUBLIC, `${name}.html`), 'utf8');
}

describe('public bilingual legal and support pages', () => {
  test.each(requiredPages)('%s has common identity, language, navigation, and contact', (name) => {
    const html = page(name);
    expect(html).toMatch(/<html\s+lang="ja"/);
    expect(html).toContain('data-lang="ja"');
    expect(html).toContain('data-lang="en"');
    expect(html).toContain('HERAC LLC');
    expect(html).toContain('herac.7.app@gmail.com');
    expect(html).toContain('2026-09-05');
    expect(html).toContain('class="skip-link"');
    for (const target of requiredPages) expect(html).toContain(`href="./${target}.html"`);
    expect(html).toContain('href="mailto:herac.7.app@gmail.com"');
    expect(html).toContain('src="./site.js"');
    expect(html).toContain('href="./styles.css"');
  });

  test('privacy matches the implemented data flow and Google Limited Use disclosure', () => {
    const html = page('privacy');
    for (const term of [
      'Supabase',
      'Google',
      'Apple',
      'Expo',
      'カレンダー',
      '旅行',
      '写真',
      'アカウント削除',
      '国外',
      '90日',
      '180日',
      '30日',
      'Google API Services User Data Policy',
      'Limited Use',
      'primary calendar',
      '作成・更新・削除',
      'Supabaseの個人バックアップ',
      'RLS',
      '広告や行動追跡を行いません',
    ]) expect(html).toContain(term);
    expect(html).toContain('https://developers.google.com/terms/api-services-user-data-policy');
    expect(html).toMatch(/OAuth[^<]{0,100}(?:バックアップ|backup)/i);
  });

  test('terms accurately cover guest risk, user content, deletion, and Japanese venue', () => {
    const html = page('terms');
    for (const term of [
      'ゲスト',
      '再インストール',
      '第三者サービス',
      'ユーザーコンテンツ',
      '禁止事項',
      'アカウント削除',
      '日本法',
      '大阪地方裁判所',
    ]) expect(html).toContain(term);
    expect(html).toContain('This permission ends after deletion');
    expect(html).toContain("You must not use another person's account");
  });

  test('deletion page names the in-app route and distinguishes Google source events', () => {
    const html = page('delete-account');
    expect(html).toContain('設定');
    expect(html).toContain('データ保存用アカウント');
    expect(html).toContain('Backup account');
    expect(html).toContain('スクロール');
    expect(html).toContain('Scroll');
    expect(html).toContain('アカウントとデータを削除');
    expect(html).toContain('Googleカレンダー上の元の予定は削除されません');
    expect(html).toContain('取り消せません');
  });

  test('privacy, support, and deletion instructions match the current Settings label', () => {
    for (const name of ['privacy', 'support', 'delete-account'] as const) {
      const html = page(name);
      expect(html).toContain('データ保存用アカウント');
      expect(html).toContain('Backup account');
      expect(html).not.toContain('アカウントとバックアップ');
      expect(html).not.toContain('Account &amp; backup');
    }
  });

  test('community rules include reporting, blocking, enforcement, and appeals', () => {
    const html = page('community-guidelines');
    for (const term of ['通報', 'ブロック', '再参加を防ぐ', '嫌がらせ', '個人情報', '異議申立て']) {
      expect(html).toContain(term);
    }
  });

  test('support explains the separate account and Calendar connections', () => {
    const html = page('support');
    expect(html).toContain('バックアップ用ログイン');
    expect(html).toContain('Googleカレンダー連携');
    expect(html).toContain('別の機能');
    expect(html).toContain('2営業日');
  });
});

describe('legal site hosting and privacy posture', () => {
  test('exposes a deterministic legal-site checker', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['check:legal']).toBe('node scripts/check-legal.mjs');
    expect(fs.existsSync(path.join(ROOT, 'scripts/check-legal.mjs'))).toBe(true);
  });

  test('ships a no-tracking, keyboard-accessible language switch', () => {
    const script = fs.readFileSync(path.join(PUBLIC, 'site.js'), 'utf8');
    const styles = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
    expect(script).toContain('localStorage');
    expect(script).not.toMatch(
      /fetch\(|XMLHttpRequest|document\.cookie|analytics|gtag|sendBeacon|WebSocket|EventSource/i,
    );
    expect(styles).toContain(':focus-visible');
    expect(styles).toContain('--focus: #1559ba');
    expect(styles).not.toContain('order: -1');
    expect(styles).toContain('prefers-reduced-motion');
    expect(styles).toMatch(/max-width:\s*72ch/);
  });

  test('Firebase Hosting disables clean URL rewrites and adds strict headers', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'legal-site/firebase.json'), 'utf8'),
    ) as { hosting: Record<string, unknown> };
    expect(config.hosting.public).toBe('public');
    expect(config.hosting.cleanUrls).toBe(false);
    expect(config.hosting.trailingSlash).toBe(false);
    const serialized = JSON.stringify(config.hosting.headers);
    for (const header of [
      'Content-Security-Policy',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'X-Frame-Options',
    ]) expect(serialized).toContain(header);
    expect(serialized).toContain("frame-ancestors 'none'");
    expect(serialized).not.toContain('unsafe-inline');
  });

  test('checker parses real tags, encoded URL schemes, and exact security headers', () => {
    const checker = path.join(ROOT, 'scripts/check-legal.mjs');
    const verifyMutationIsRejected = (mutate: (temporaryRoot: string) => void) => {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recoto-legal-'));
      try {
        fs.cpSync(path.join(ROOT, 'legal-site'), path.join(temporaryRoot, 'legal-site'), {
          recursive: true,
        });
        mutate(temporaryRoot);
        const result = spawnSync(process.execPath, [checker, '--root', temporaryRoot], {
          encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    };

    verifyMutationIsRejected((temporaryRoot) => {
      const file = path.join(temporaryRoot, 'legal-site/public/index.html');
      fs.writeFileSync(
        file,
        fs.readFileSync(file, 'utf8').replace(
          '<script src="./site.js" defer></script>',
          '<!-- src="./site.js" --><script>void 0</script>',
        ),
      );
    });
    verifyMutationIsRejected((temporaryRoot) => {
      const file = path.join(temporaryRoot, 'legal-site/public/index.html');
      fs.appendFileSync(file, '<a href="j&#x61;vascript:alert(1)">unsafe</a>');
    });
    verifyMutationIsRejected((temporaryRoot) => {
      const file = path.join(temporaryRoot, 'legal-site/firebase.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.hosting.headers[0].headers[0].value = "default-src *; frame-ancestors 'none'";
      fs.writeFileSync(file, JSON.stringify(config));
    });
  });

  test('example Firebase project file contains no real project identifier', () => {
    const config = fs.readFileSync(path.join(ROOT, 'legal-site/.firebaserc.example'), 'utf8');
    expect(config).toContain('YOUR_FIREBASE_PROJECT_ID');
    expect(config).not.toContain('schedule-98b25');
  });

  test('pins production hosting to the verified Schedule Firebase project and site', () => {
    const projectConfig = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'legal-site/.firebaserc'), 'utf8'),
    ) as { projects?: { default?: string } };
    const hostingConfig = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'legal-site/firebase.json'), 'utf8'),
    ) as { hosting?: { site?: string } };

    expect(projectConfig.projects?.default).toBe('schedule-98b25');
    expect(hostingConfig.hosting?.site).toBe('schedule-98b25');
  });
});
