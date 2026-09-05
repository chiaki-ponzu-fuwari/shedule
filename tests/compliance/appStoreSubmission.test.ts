import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const APP_STORE_DOCS = path.join(ROOT, 'docs/app-store');
const ACCOUNT_BACKUP_CARD = path.join(ROOT, 'components/settings/AccountBackupCard.tsx');

function read(name: string): string {
  return fs.readFileSync(path.join(APP_STORE_DOCS, name), 'utf8');
}

describe('App Store submission evidence', () => {
  test('documents App Privacy answers without claiming tracking or unverified completion', () => {
    const answers = read('app-privacy-answers.md');

    for (const category of [
      'User ID',
      'Name',
      'Email Address',
      'Contacts',
      'Customer Support',
      'Coarse Location',
      'Precise Location',
      'Device ID',
      'Other Diagnostic Data',
      'Performance Data',
      'Other Data Types',
      'Other User Content',
      'Photos or Videos',
    ]) {
      expect(answers).toContain(category);
    }
    expect(answers).toContain('Linked to User');
    expect(answers).toContain('App Functionality');
    expect(answers).toContain('Not used for tracking');
    expect(answers).toContain('未確認');
  });

  test('keeps reviewer credentials out of Git and explains every review-critical route', () => {
    const notes = read('review-notes.md');

    for (const route of [
      'ゲスト',
      '旅行',
      'Google',
      'Apple',
      'グループ',
      '通報',
      'ブロック',
      'アカウントとデータを削除',
    ]) {
      expect(notes).toContain(route);
    }
    expect(notes).toContain('<APP_REVIEW_TEST_ACCOUNT_A>');
    expect(notes).toContain('<APP_REVIEW_DELETION_ACCOUNT>');
    expect(notes).toContain('<CURRENT_GROUP_INVITE_CODE>');
    expect(notes).toContain('パスワードはGitに保存しない');
    expect(notes).toContain('iOS版ではGoogle Calendar連携を表示しない');
    expect(notes).toContain('select **EN**');
    expect(notes).toContain('**Info**');
    expect(notes).toContain('**Write a diary entry…**');
    expect(notes).not.toContain('**Group info**');
    expect(notes).not.toContain('tap **Write diary**');
    expect(notes).toContain('<APP_REVIEW_PROVIDER_A>');
    expect(notes).toContain('**Continue with Apple**');
    expect(notes).not.toContain('**Save with Apple**');

    const accountBackupCard = fs.readFileSync(ACCOUNT_BACKUP_CARD, 'utf8');
    expect(accountBackupCard).toContain('AppleAuthenticationButtonType.CONTINUE');
  });

  test('keeps every credential-dependent release gate visibly unchecked', () => {
    const checklist = read('release-checklist.md');

    for (const gate of [
      'Xcode 26',
      'iOS 26 SDK',
      'Privacy Report',
      'TestFlight',
      '2アカウント',
      '審査中のバックエンド稼働',
      '携帯回線',
    ]) {
      expect(checklist).toContain(gate);
    }
    expect(checklist).toContain('- [ ]');
    expect(checklist).not.toContain('- [x]');
    expect(checklist).toContain('App Store Connectへ貼り付けたコピー');
    expect(checklist).toContain('保持期間を本番で検証するまで法務サイトを公開しない');
    expect(checklist).toContain('別々のクリーンインストール');
  });
});
