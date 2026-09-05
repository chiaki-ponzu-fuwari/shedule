import * as Crypto from 'expo-crypto';
import type { StateStorage } from 'zustand/middleware';

const INSTALLATION_ID_KEY = 'recoto:installation-id';
const LAST_OWNER_HINT_KEY = 'recoto:active-data-owner';
const MIGRATION_COMPLETE_PREFIX = 'recoto:migration-complete:';
const MIGRATION_POINTER_PREFIX = 'recoto:migration-pointer:';
const MIGRATION_BACKUP_PREFIX = 'recoto:migration-backup:';

export type DataOwner = { kind: 'guest'; id: string } | { kind: 'user'; id: string };

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface OwnerStorageDependencies {
  randomUUID: () => string;
  now: () => Date;
}

export interface OwnerStorage {
  getOwner(): Promise<DataOwner>;
  switchOwner(owner: DataOwner): Promise<void>;
  key(domain: string): string;
  migrateLegacy(oldKey: string, domain: string): Promise<{ migrated: boolean }>;
}

interface OwnerStorageInternals {
  storage: KeyValueStorage;
  initialize(): Promise<DataOwner>;
  setOwner(owner: DataOwner): Promise<void>;
  enqueueOwnerOperation<T>(operation: () => Promise<T>): Promise<T>;
  readDomain(domain: string): Promise<string | null>;
  writeDomain(domain: string, value: string): Promise<void>;
  removeDomain(domain: string): Promise<void>;
  suspendWrites(): () => void;
}

const internalsByOwnerStorage = new WeakMap<OwnerStorage, OwnerStorageInternals>();
let sharedPersonalOwnerStorage: OwnerStorage | null = null;
let sharedPersonalStorageBackend: KeyValueStorage | null = null;

function validateSegment(value: string, label: string) {
  if (!value || value.includes(':')) {
    throw new Error(`${label} must be a non-empty storage key segment`);
  }
}

export function createOwnerStorage(
  storage: KeyValueStorage,
  dependencyOverrides: Partial<OwnerStorageDependencies> = {}
): OwnerStorage {
  const dependencies: OwnerStorageDependencies = {
    randomUUID: () => Crypto.randomUUID(),
    now: () => new Date(),
    ...dependencyOverrides,
  };
  let generatedInstallationId: string | null = null;
  let installationId: string | null = null;
  let currentOwner: DataOwner | null = null;
  let initialized = false;
  let initialization: Promise<DataOwner> | null = null;
  let writeSuspensionCount = 0;
  let ownerOperationQueue: Promise<void> = Promise.resolve();

  const getGeneratedInstallationId = () => {
    if (generatedInstallationId) return generatedInstallationId;
    const generated = dependencies.randomUUID();
    validateSegment(generated, 'installation id');
    generatedInstallationId = generated;
    return generated;
  };

  const initialize = () => {
    if (initialized) return Promise.resolve(currentOwner!);
    if (initialization) return initialization;

    const pending = (async () => {
      const storedInstallationId = await storage.getItem(INSTALLATION_ID_KEY);
      const durableInstallationId = storedInstallationId || getGeneratedInstallationId();
      validateSegment(durableInstallationId, 'installation id');
      if (!storedInstallationId) {
        await storage.setItem(INSTALLATION_ID_KEY, durableInstallationId);
      }

      // Authentication is not established at this boundary. A previous user marker is
      // only a hint and must never select a private cache during cold start.
      const owner: DataOwner = { kind: 'guest', id: durableInstallationId };
      installationId = durableInstallationId;
      currentOwner = owner;
      initialized = true;
      return owner;
    })();

    initialization = pending;
    void pending.catch(() => {
      if (initialization === pending) initialization = null;
    });
    return pending;
  };

  const setOwner = async (owner: DataOwner) => {
    await initialize();
    validateSegment(owner.id, 'owner id');
    const normalizedOwner: DataOwner =
      owner.kind === 'guest' ? { kind: 'guest', id: installationId! } : { ...owner };

    // This persisted value is diagnostic/recovery metadata only. Cold start never
    // trusts it until authentication selects an owner explicitly.
    await storage.setItem(LAST_OWNER_HINT_KEY, JSON.stringify(normalizedOwner));
    currentOwner = normalizedOwner;
  };

  const enqueueOwnerOperation = <T>(operation: () => Promise<T>) => {
    const result = ownerOperationQueue.then(operation, operation);
    ownerOperationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const ownerStorage: OwnerStorage = {
    getOwner: initialize,

    switchOwner: (owner) => enqueueOwnerOperation(() => setOwner(owner)),

    key(domain) {
      validateSegment(domain, 'domain');
      const owner = currentOwner ?? { kind: 'guest', id: getGeneratedInstallationId() };
      return `recoto:${owner.kind}:${owner.id}:${domain}`;
    },

    async migrateLegacy(oldKey, domain) {
      validateSegment(oldKey, 'legacy key');
      validateSegment(domain, 'domain');
      await initialize();

      const completionKey = `${MIGRATION_COMPLETE_PREFIX}${oldKey}`;
      if ((await storage.getItem(completionKey)) === '1') return { migrated: false };

      const legacyValue = await storage.getItem(oldKey);
      if (legacyValue === null) {
        await storage.setItem(completionKey, '1');
        return { migrated: false };
      }

      const pointerKey = `${MIGRATION_POINTER_PREFIX}${oldKey}`;
      let backupKey = await storage.getItem(pointerKey);
      if (!backupKey) {
        backupKey = `${MIGRATION_BACKUP_PREFIX}${dependencies.now().toISOString()}:${oldKey}`;
        await storage.setItem(pointerKey, backupKey);
      }

      if ((await storage.getItem(backupKey)) === null) {
        await storage.setItem(backupKey, legacyValue);
      }

      const guestKey = `recoto:guest:${installationId!}:${domain}`;
      if ((await storage.getItem(guestKey)) === null) {
        await storage.setItem(guestKey, legacyValue);
      }

      await storage.setItem(completionKey, '1');
      return { migrated: true };
    },
  };

  const internals: OwnerStorageInternals = {
    storage,
    initialize,
    setOwner,
    enqueueOwnerOperation,
    async readDomain(domain) {
      await initialize();
      return storage.getItem(ownerStorage.key(domain));
    },
    async writeDomain(domain, value) {
      const suspendedAtInvocation = writeSuspensionCount > 0;
      if (suspendedAtInvocation) return;
      await initialize();
      const storageKey = ownerStorage.key(domain);
      await storage.setItem(storageKey, value);
    },
    async removeDomain(domain) {
      const suspendedAtInvocation = writeSuspensionCount > 0;
      if (suspendedAtInvocation) return;
      await initialize();
      const storageKey = ownerStorage.key(domain);
      await storage.removeItem(storageKey);
    },
    suspendWrites() {
      writeSuspensionCount += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        writeSuspensionCount = Math.max(0, writeSuspensionCount - 1);
      };
    },
  };
  internalsByOwnerStorage.set(ownerStorage, internals);
  return ownerStorage;
}

export function getPersonalOwnerStorage(storage: KeyValueStorage): OwnerStorage {
  if (!sharedPersonalOwnerStorage) {
    sharedPersonalOwnerStorage = createOwnerStorage(storage);
    sharedPersonalStorageBackend = storage;
  } else if (sharedPersonalStorageBackend !== storage) {
    throw new Error('Personal owner storage is already bound to another storage backend');
  }
  return sharedPersonalOwnerStorage;
}

const DEFAULT_LEGACY_KEYS: Readonly<Record<string, string>> = {
  calendar: 'calendar-storage',
  stamps: 'stamp-storage-v15',
};

export function createOwnerStateStorage(
  ownerStorage: OwnerStorage,
  legacyKeys: Readonly<Record<string, string>> = DEFAULT_LEGACY_KEYS
): StateStorage {
  const internals = internalsByOwnerStorage.get(ownerStorage);
  if (!internals) throw new Error('Owner storage was not created by createOwnerStorage');

  return {
    async getItem(domain) {
      const legacyKey = legacyKeys[domain];
      if (legacyKey) await ownerStorage.migrateLegacy(legacyKey, domain);
      return internals.readDomain(domain);
    },
    setItem: (domain, value) => internals.writeDomain(domain, value),
    removeItem: (domain) => internals.removeDomain(domain),
  };
}

export interface OwnerSwitchTarget<T> {
  snapshot(): T;
  clearForOwnerSwitch(): void;
  replaceState(snapshot: T): void;
  rehydrate(): void | Promise<void>;
  hasHydrated(): boolean;
}

export function switchOwnerAndRehydrate({
  ownerStorage,
  owner,
  targets,
}: {
  ownerStorage: OwnerStorage;
  owner: DataOwner;
  targets: readonly OwnerSwitchTarget<unknown>[];
}): Promise<void> {
  const internals = internalsByOwnerStorage.get(ownerStorage);
  if (!internals) return Promise.reject(new Error('Unknown owner storage'));

  return internals.enqueueOwnerOperation(async () => {
    const snapshots = targets.map((target) => target.snapshot());
    const releaseWrites = internals.suspendWrites();
    let previousOwner: DataOwner | null = null;
    let ownerWasSwitched = false;
    try {
      targets.forEach((target) => target.clearForOwnerSwitch());
      previousOwner = await ownerStorage.getOwner();
      await internals.setOwner(owner);
      ownerWasSwitched = true;
      await Promise.all(targets.map((target) => Promise.resolve(target.rehydrate())));
      if (targets.some((target) => !target.hasHydrated())) {
        throw new Error('Owner cache hydration did not complete');
      }
    } catch (error) {
      let restoredPreviousOwner = !ownerWasSwitched;
      if (previousOwner && ownerWasSwitched) {
        try {
          await internals.setOwner(previousOwner);
          restoredPreviousOwner = true;
        } catch {
          restoredPreviousOwner = false;
        }
      }

      if (restoredPreviousOwner) {
        targets.forEach((target, index) => target.replaceState(snapshots[index]));
      } else {
        targets.forEach((target) => target.clearForOwnerSwitch());
      }
      throw error;
    } finally {
      releaseWrites();
    }
  });
}
