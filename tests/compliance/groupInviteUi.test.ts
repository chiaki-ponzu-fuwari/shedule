import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

describe('secure group invite UI', () => {
  test('accepts the full secure code and renders it compactly', () => {
    const groupsScreen = fs.readFileSync(path.join(ROOT, 'app/(tabs)/groups.tsx'), 'utf8');
    const detailSheet = fs.readFileSync(
      path.join(ROOT, 'components/groups/GroupDetailSheet.tsx'),
      'utf8'
    );

    expect(groupsScreen).toMatch(/maxLength=\{32\}/);
    expect(groupsScreen).toContain("t('groups.invitePlaceholder')");
    expect(groupsScreen).toMatch(/codeInput:\s*\{[^}]*fontSize:\s*16[^}]*letterSpacing:\s*1/);
    expect(detailSheet).toMatch(/inviteCode:\s*\{[^}]*fontSize:\s*13[^}]*letterSpacing:\s*1/);
  });
});
