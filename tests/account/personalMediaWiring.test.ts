import fs from 'node:fs';

describe('personal media production wiring', () => {
  test('runs durable media reconciliation around the ordinary cloud producer', () => {
    const hook = fs.readFileSync('hooks/useAccountCloudSync.ts', 'utf8');
    const runtime = fs.readFileSync('lib/account/productionPersonalMediaRuntime.ts', 'utf8');
    expect(hook).toContain('createProductionPersonalMediaRuntime');
    expect(hook).toContain('createMediaAwareCloudSyncProducer');
    expect(runtime).toContain('media.reconcile()');
  });

  test('renders every personal image surface through the private-media resolver', () => {
    const files = [
      'components/calendar/DayCell.tsx',
      'components/calendar/WeeklyView.tsx',
      'components/modals/DayDetailSheet.tsx',
      'components/modals/DayViewSheet.tsx',
      'app/(tabs)/settings.tsx',
    ];
    for (const file of files) {
      expect(fs.readFileSync(file, 'utf8')).toContain('PersonalMediaImage');
    }
  });
});
