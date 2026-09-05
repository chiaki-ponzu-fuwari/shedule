import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

const PHOTO_PICKER_FILES = [
  'app/(tabs)/settings.tsx',
  'app/(tabs)/groups.tsx',
  'components/groups/GroupDetailSheet.tsx',
  'components/modals/DayDetailSheet.tsx',
  'components/calendar/WeeklyView.tsx',
];

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('contextual permissions', () => {
  test.each(PHOTO_PICKER_FILES)(
    '%s opens the system photo picker without a media-library preflight request',
    (relativePath) => {
      const source = readSource(relativePath);

      expect(source).toContain('launchImageLibraryAsync');
      expect(source).not.toContain('requestMediaLibraryPermissionsAsync');
    },
  );

  test('the root layout does not request notification permission', () => {
    expect(readSource('app/_layout.tsx')).not.toContain('requestNotificationPermission');
  });
});
