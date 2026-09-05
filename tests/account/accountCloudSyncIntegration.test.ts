import fs from 'node:fs';

describe('account cloud sync production wiring', () => {
  test('mounts the sync hook only inside the bootstrapped application', () => {
    const rootLayout = fs.readFileSync('app/_layout.tsx', 'utf8');
    expect(rootLayout).toContain("import { useAccountCloudSync } from '../hooks/useAccountCloudSync';");
    const bootstrappedStart = rootLayout.indexOf('export function BootstrappedApplication()');
    const call = rootLayout.indexOf('useAccountCloudSync();');
    expect(call).toBeGreaterThan(bootstrappedStart);
  });

  test('subscribes all currently implemented personal stores and app foreground state', () => {
    const hook = fs.readFileSync('hooks/useAccountCloudSync.ts', 'utf8');
    expect(hook).toContain('useCalendarStore.subscribe');
    expect(hook).toContain('useStampStore.subscribe');
    expect(hook).toContain('useLocaleStore.subscribe');
    expect(hook).toContain('useTripStore.subscribe');
    expect(hook).toContain('AppState');
    expect(hook).toContain('createAccountCloudSyncTriggerBinding');
    expect(hook).toContain('credentialAllowsCloud');
    expect(hook).toContain('canRun: () => ownerCanUseCloud(ownerId)');
  });

  test('includes the trip owner store in bootstrap snapshots, persistence, and owner switches', () => {
    const persistence = fs.readFileSync('lib/account/accountBootstrapPersistence.ts', 'utf8');
    expect(persistence).toContain("from '../../store/tripStore'");
    expect(persistence).toContain('trips: trips.trips');
    expect(persistence).toContain('tripItems: trips.items');
    expect(persistence).toContain("targetStorage.setItem('trips'");
    expect(persistence).toContain('useTripStore.getState().replaceFromCloud');
    expect(persistence).toContain('createTripOwnerSwitchTarget()');
  });
});
