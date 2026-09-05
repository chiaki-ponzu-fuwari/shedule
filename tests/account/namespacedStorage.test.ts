import {
  createOwnerStateStorage,
  createOwnerStorage,
  switchOwnerAndRehydrate,
  type OwnerSwitchTarget,
} from '../../lib/account/namespacedStorage';

class MemoryStorage {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  readonly writes: Array<[string, string]> = [];
  readonly removals: string[] = [];
  failReads = false;
  failWritesFor = new Set<string>();

  async getItem(key: string) {
    if (this.failReads) throw new Error('storage unavailable');
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string) {
    if (this.failWritesFor.has(key)) throw new Error(`write failed: ${key}`);
    this.values.set(key, value);
    this.writes.push([key, value]);
  }

  async removeItem(key: string) {
    this.values.delete(key);
    this.removals.push(key);
  }
}

const fixedDependencies = (installationId = 'install-1') => ({
  randomUUID: () => installationId,
  now: () => new Date('2026-09-05T12:34:56.000Z'),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('uses a durable installation id for guest keys and a uid for user keys', async () => {
  const storage = new MemoryStorage();
  const ownerStorage = createOwnerStorage(storage, fixedDependencies());

  expect(ownerStorage.key('calendar')).toBe('recoto:guest:install-1:calendar');
  await expect(ownerStorage.getOwner()).resolves.toEqual({ kind: 'guest', id: 'install-1' });
  expect(storage.values.get('recoto:installation-id')).toBe('install-1');

  const relaunched = createOwnerStorage(storage, fixedDependencies('new-random-id'));
  await expect(relaunched.getOwner()).resolves.toEqual({ kind: 'guest', id: 'install-1' });
  expect(relaunched.key('stamps')).toBe('recoto:guest:install-1:stamps');

  await relaunched.switchOwner({ kind: 'user', id: 'user-b' });
  expect(relaunched.key('calendar')).toBe('recoto:user:user-b:calendar');

  storage.values.set('recoto:guest:install-1:calendar', 'guest-data');
  storage.values.set('recoto:user:user-b:calendar', 'private-b');
  const coldStart = createOwnerStorage(storage, fixedDependencies('unused-random-id'));
  await expect(coldStart.getOwner()).resolves.toEqual({ kind: 'guest', id: 'install-1' });
  expect(coldStart.key('calendar')).toBe('recoto:guest:install-1:calendar');
  expect(await createOwnerStateStorage(coldStart).getItem('calendar')).toBe('guest-data');
  expect(storage.reads).not.toContain('recoto:user:user-b:calendar');
});

test('migrates a legacy value once and preserves a timestamped read-only backup', async () => {
  const storage = new MemoryStorage();
  const legacyPayload = JSON.stringify({ state: { entries: { a: 1 } }, version: 0 });
  storage.values.set('calendar-storage', legacyPayload);
  const ownerStorage = createOwnerStorage(storage, fixedDependencies());

  await ownerStorage.getOwner();
  await expect(ownerStorage.migrateLegacy('calendar-storage', 'calendar')).resolves.toEqual({
    migrated: true,
  });

  const backupKey =
    'recoto:migration-backup:2026-09-05T12:34:56.000Z:calendar-storage';
  expect(storage.values.get('recoto:guest:install-1:calendar')).toBe(legacyPayload);
  expect(storage.values.get(backupKey)).toBe(legacyPayload);
  expect(storage.values.get('calendar-storage')).toBe(legacyPayload);
  expect(storage.removals).not.toContain('calendar-storage');

  storage.values.set('calendar-storage', 'changed-after-migration');
  await expect(ownerStorage.migrateLegacy('calendar-storage', 'calendar')).resolves.toEqual({
    migrated: false,
  });
  expect(storage.values.get(backupKey)).toBe(legacyPayload);
  expect(
    storage.writes.filter(([key]) => key.startsWith('recoto:migration-backup:'))
  ).toHaveLength(1);
});

test('does not overwrite an existing guest namespace during legacy migration', async () => {
  const storage = new MemoryStorage();
  storage.values.set('calendar-storage', 'legacy');
  storage.values.set('recoto:guest:install-1:calendar', 'newer-guest-data');
  const ownerStorage = createOwnerStorage(storage, fixedDependencies());

  await expect(ownerStorage.migrateLegacy('calendar-storage', 'calendar')).resolves.toEqual({
    migrated: true,
  });
  expect(storage.values.get('recoto:guest:install-1:calendar')).toBe('newer-guest-data');
});

test('clears user A before user B rehydrates without writing the empty state over A', async () => {
  const storage = new MemoryStorage();
  const ownerStorage = createOwnerStorage(storage, fixedDependencies());
  await ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
  storage.values.set('recoto:user:user-a:calendar', 'calendar-a');
  storage.values.set('recoto:user:user-a:stamps', 'stamps-a');
  storage.values.set('recoto:user:user-b:calendar', 'calendar-b');
  storage.values.set('recoto:user:user-b:stamps', 'stamps-b');

  const stateStorage = createOwnerStateStorage(ownerStorage);
  const clearStarted = deferred<void>();
  const rehydrateBarrier = deferred<void>();
  const visibleCalendar: string[] = ['calendar-a'];
  const visibleStamps: string[] = ['stamps-a'];
  let calendar = 'calendar-a';
  let stamps = 'stamps-a';

  const targets: OwnerSwitchTarget<string>[] = [
    {
      snapshot: () => calendar,
      clearForOwnerSwitch: () => {
        calendar = 'calendar-empty';
        visibleCalendar.push(calendar);
        clearStarted.resolve();
        void stateStorage.setItem('calendar', calendar);
      },
      replaceState: (value) => {
        calendar = value;
        visibleCalendar.push(value);
      },
      rehydrate: async () => {
        await rehydrateBarrier.promise;
        calendar = (await stateStorage.getItem('calendar')) ?? 'calendar-empty';
        visibleCalendar.push(calendar);
      },
      hasHydrated: () => true,
    },
    {
      snapshot: () => stamps,
      clearForOwnerSwitch: () => {
        stamps = 'stamps-empty';
        visibleStamps.push(stamps);
        void stateStorage.setItem('stamps', stamps);
      },
      replaceState: (value) => {
        stamps = value;
        visibleStamps.push(value);
      },
      rehydrate: async () => {
        await rehydrateBarrier.promise;
        stamps = (await stateStorage.getItem('stamps')) ?? 'stamps-empty';
        visibleStamps.push(stamps);
      },
      hasHydrated: () => true,
    },
  ];

  const switching = switchOwnerAndRehydrate({
    ownerStorage,
    owner: { kind: 'user', id: 'user-b' },
    targets,
  });

  await clearStarted.promise;
  expect(calendar).toBe('calendar-empty');
  expect(stamps).toBe('stamps-empty');
  expect(storage.values.get('recoto:user:user-a:calendar')).toBe('calendar-a');
  expect(storage.values.get('recoto:user:user-a:stamps')).toBe('stamps-a');

  rehydrateBarrier.resolve();
  await switching;

  expect(calendar).toBe('calendar-b');
  expect(stamps).toBe('stamps-b');
  expect(visibleCalendar).toEqual(['calendar-a', 'calendar-empty', 'calendar-b']);
  expect(visibleStamps).toEqual(['stamps-a', 'stamps-empty', 'stamps-b']);
});

test('a failed owner write keeps the previous namespace and restores memory', async () => {
  const storage = new MemoryStorage();
  const ownerStorage = createOwnerStorage(storage, fixedDependencies());
  await ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
  storage.failWritesFor.add('recoto:active-data-owner');
  let state = 'private-a';
  const target: OwnerSwitchTarget<string> = {
    snapshot: () => state,
    clearForOwnerSwitch: () => {
      state = 'empty';
    },
    replaceState: (value) => {
      state = value;
    },
    rehydrate: jest.fn(),
    hasHydrated: () => true,
  };

  await expect(
    switchOwnerAndRehydrate({
      ownerStorage,
      owner: { kind: 'user', id: 'user-b' },
      targets: [target],
    })
  ).rejects.toThrow('write failed');

  expect(ownerStorage.key('calendar')).toBe('recoto:user:user-a:calendar');
  expect(state).toBe('private-a');
});

test('a write started before switching finishes in user A namespace', async () => {
  const storage = new MemoryStorage();
  const ownerStorage = createOwnerStorage(storage, fixedDependencies());
  await ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
  const stateStorage = createOwnerStateStorage(ownerStorage);
  const pendingWrite = stateStorage.setItem('calendar', 'latest-a');
  let state = 'latest-a';

  const switching = switchOwnerAndRehydrate({
    ownerStorage,
    owner: { kind: 'user', id: 'user-b' },
    targets: [
      {
        snapshot: () => state,
        clearForOwnerSwitch: () => {
          state = 'empty';
        },
        replaceState: (value: unknown) => {
          state = String(value);
        },
        rehydrate: async () => undefined,
        hasHydrated: () => true,
      },
    ],
  });

  await Promise.all([pendingWrite, switching]);
  expect(storage.values.get('recoto:user:user-a:calendar')).toBe('latest-a');
  expect(storage.values.get('recoto:user:user-b:calendar')).toBeUndefined();
});

test('an incomplete Zustand rehydrate rolls back to user A without exposing partial B state', async () => {
  const storage = new MemoryStorage();
  const ownerStorage = createOwnerStorage(storage, fixedDependencies());
  await ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
  let state = 'private-a';

  await expect(
    switchOwnerAndRehydrate({
      ownerStorage,
      owner: { kind: 'user', id: 'user-b' },
      targets: [
        {
          snapshot: () => state,
          clearForOwnerSwitch: () => {
            state = 'empty';
          },
          replaceState: (value: unknown) => {
            state = String(value);
          },
          rehydrate: async () => {
            state = 'partial-b';
          },
          hasHydrated: () => false,
        },
      ],
    })
  ).rejects.toThrow('Owner cache hydration did not complete');

  expect(ownerStorage.key('calendar')).toBe('recoto:user:user-a:calendar');
  expect(state).toBe('private-a');
});

test('serializes B and C switches so the owner stays stable throughout each rehydrate', async () => {
  const storage = new MemoryStorage();
  const ownerStorage = createOwnerStorage(storage, fixedDependencies());
  await ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
  const bStarted = deferred<void>();
  const bCanFinish = deferred<void>();
  const cStarted = deferred<void>();
  const cCanFinish = deferred<void>();
  const observedOwnerKeys: string[] = [];
  const visibleStates: string[] = ['user-a'];
  let state = 'user-a';

  const target: OwnerSwitchTarget<string> = {
    snapshot: () => state,
    clearForOwnerSwitch: () => {
      state = 'empty';
      visibleStates.push(state);
    },
    replaceState: (value) => {
      state = value;
      visibleStates.push(value);
    },
    rehydrate: async () => {
      const ownerKey = ownerStorage.key('calendar');
      observedOwnerKeys.push(ownerKey);
      if (ownerKey.includes(':user-b:')) {
        bStarted.resolve();
        await bCanFinish.promise;
        expect(ownerStorage.key('calendar')).toContain(':user-b:');
        state = 'user-b';
      } else {
        cStarted.resolve();
        await cCanFinish.promise;
        expect(ownerStorage.key('calendar')).toContain(':user-c:');
        state = 'user-c';
      }
      visibleStates.push(state);
    },
    hasHydrated: () => true,
  };

  const switchToB = switchOwnerAndRehydrate({
    ownerStorage,
    owner: { kind: 'user', id: 'user-b' },
    targets: [target],
  });
  const switchToC = switchOwnerAndRehydrate({
    ownerStorage,
    owner: { kind: 'user', id: 'user-c' },
    targets: [target],
  });

  await bStarted.promise;
  expect(ownerStorage.key('calendar')).toContain(':user-b:');
  expect(observedOwnerKeys).toEqual(['recoto:user:user-b:calendar']);

  bCanFinish.resolve();
  await switchToB;
  await cStarted.promise;
  expect(ownerStorage.key('calendar')).toContain(':user-c:');
  expect(observedOwnerKeys).toEqual([
    'recoto:user:user-b:calendar',
    'recoto:user:user-c:calendar',
  ]);

  cCanFinish.resolve();
  await switchToC;
  expect(visibleStates).toEqual(['user-a', 'empty', 'user-b', 'empty', 'user-c']);
});

test('restores the snapshot when owner initialization fails before the marker can change', async () => {
  const storage = new MemoryStorage();
  storage.failReads = true;
  const ownerStorage = createOwnerStorage(storage, fixedDependencies());
  const visibleStates = ['private-before-init'];
  let state = 'private-before-init';

  await expect(
    switchOwnerAndRehydrate({
      ownerStorage,
      owner: { kind: 'user', id: 'user-b' },
      targets: [
        {
          snapshot: () => state,
          clearForOwnerSwitch: () => {
            state = 'empty';
            visibleStates.push(state);
          },
          replaceState: (value: unknown) => {
            state = String(value);
            visibleStates.push(state);
          },
          rehydrate: async () => undefined,
          hasHydrated: () => true,
        },
      ],
    })
  ).rejects.toThrow('storage unavailable');

  expect(state).toBe('private-before-init');
  expect(visibleStates).toEqual(['private-before-init', 'empty', 'private-before-init']);
  expect(storage.writes).toEqual([]);
});

test('storage read and migration failures reject without marking migration complete', async () => {
  const unavailable = new MemoryStorage();
  unavailable.failReads = true;
  const unreadableOwnerStorage = createOwnerStorage(unavailable, fixedDependencies());
  await expect(unreadableOwnerStorage.getOwner()).rejects.toThrow('storage unavailable');

  const storage = new MemoryStorage();
  storage.values.set('calendar-storage', 'legacy');
  const ownerStorage = createOwnerStorage(storage, fixedDependencies());
  await ownerStorage.getOwner();
  storage.failWritesFor.add('recoto:guest:install-1:calendar');

  await expect(ownerStorage.migrateLegacy('calendar-storage', 'calendar')).rejects.toThrow(
    'write failed'
  );
  expect(storage.values.get('recoto:migration-complete:calendar-storage')).toBeUndefined();
});

describe('owner-scoped Zustand stores', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('calendar and stamp state write only to the active owner namespace', async () => {
    const storage = new MemoryStorage();
    jest.resetModules();
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      __esModule: true,
      default: storage,
    }));
    jest.doMock('expo-crypto', () => ({ randomUUID: () => 'store-install' }));

    const { createCalendarOwnerSwitchTarget, useCalendarStore } =
      require('../../store/calendarStore') as typeof import('../../store/calendarStore');
    const { createStampOwnerSwitchTarget, useStampStore } =
      require('../../store/stampStore') as typeof import('../../store/stampStore');

    await Promise.all([
      Promise.resolve(useCalendarStore.persist.rehydrate()),
      Promise.resolve(useStampStore.persist.rehydrate()),
    ]);

    useCalendarStore.getState().setNotes('2026-09-05', 'guest note');
    useStampStore.getState().addStamp({
      id: 'guest-stamp',
      text: 'G',
      bgColor: '#000000',
      textColor: '#FFFFFF',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(storage.values.has('recoto:guest:store-install:calendar')).toBe(true);
    expect(storage.values.has('recoto:guest:store-install:stamps')).toBe(true);
    expect(storage.values.has('calendar-storage')).toBe(false);
    expect(storage.values.has('stamp-storage-v15')).toBe(false);
    expect(useCalendarStore.getState().replaceState).toEqual(expect.any(Function));
    expect(useCalendarStore.getState().clearForOwnerSwitch).toEqual(expect.any(Function));
    expect(useStampStore.getState().replaceState).toEqual(expect.any(Function));
    expect(useStampStore.getState().clearForOwnerSwitch).toEqual(expect.any(Function));
    expect(createCalendarOwnerSwitchTarget().hasHydrated).toEqual(expect.any(Function));
    expect(createStampOwnerSwitchTarget().hasHydrated).toEqual(expect.any(Function));
  });
});
