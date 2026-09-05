jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import {
  ACCOUNT_BOOTSTRAP_BINDING_KEY,
  ACCOUNT_COMMIT_JOURNAL_DOMAIN,
  ACCOUNT_CONFLICT_BACKUP_DOMAIN,
  ACCOUNT_LOCAL_BACKUP_DOMAIN,
  ACCOUNT_OUTBOX_DOMAIN,
  ACCOUNT_SYNC_STATE_DOMAIN,
  ACCOUNT_TRANSITION_SOURCE_DOMAIN,
  ACCOUNT_TRANSITION_MEDIA_DOMAIN,
  clearAccountTransitionMediaHandoff,
  createAccountBootstrapOutbox,
  createAccountBootstrapPersistence,
  type AccountBootstrapLocalBridge,
  type AccountRuntimePublishGuard,
} from '../../lib/account/accountBootstrapPersistence';
import { createMemoryCloudRepository } from '../../lib/account/cloudRepository';
import {
  createOwnerStateStorage,
  createOwnerStorage,
  type KeyValueStorage,
} from '../../lib/account/namespacedStorage';
import type { PersonalSnapshot } from '../../types/account';
import { emptyPersonalSnapshot } from './fixtures';
import {
  createPortableSnapshot,
  type PersonalSnapshotInput,
} from '../../lib/account/personalSnapshot';

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();

  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
}

function snapshot(note: string): PersonalSnapshot {
  return {
    ...emptyPersonalSnapshot(),
    entries: {
      '2026-09-05': {
        date: '2026-09-05',
        miniStamps: {},
        privacyLevel: 2,
        notes: note,
      },
    },
    preferences: { weekStartDay: 1, locale: 'ja' },
    stamps: [{ id: 'work', text: '仕事', bgColor: '#fff', textColor: '#000' }],
  };
}

function createFixture({
  stageTransitionMedia,
}: {
  stageTransitionMedia?: (ownerId: string, snapshot: PersonalSnapshot) => Promise<void>;
} = {}) {
  const storage = new MemoryStorage();
  const ownerStorage = createOwnerStorage(storage, {
    randomUUID: () => 'install-1',
    now: () => new Date('2026-09-05T12:00:00.000Z'),
  });
  let visible = snapshot('guest');
  let failPersistOnce = false;
  let afterPersistOnce: (() => void) | null = null;
  const local: AccountBootstrapLocalBridge = {
    readSnapshot: () => createPortableSnapshot(
      JSON.parse(JSON.stringify(visible)) as PersonalSnapshotInput,
    ),
    readRuntimeSnapshot: () => JSON.parse(JSON.stringify(visible)) as PersonalSnapshot,
    persistSnapshot: async (value) => {
      if (failPersistOnce) {
        failPersistOnce = false;
        throw new Error('interrupted cache commit');
      }
      const stateStorage = createOwnerStateStorage(ownerStorage);
      await stateStorage.setItem('test-snapshot', JSON.stringify(value));
      const callback = afterPersistOnce;
      afterPersistOnce = null;
      callback?.();
    },
    replaceSnapshot: (value) => {
      visible = JSON.parse(JSON.stringify(value)) as PersonalSnapshot;
    },
  };
  const createPersistence = () => createAccountBootstrapPersistence({
    storage,
    ownerStorage,
    local,
    stageTransitionMedia,
    now: () => new Date('2026-09-05T12:00:00.000Z'),
  });
  const persistence = createPersistence();
  return {
    storage,
    ownerStorage,
    persistence,
    recreatePersistence: createPersistence,
    local,
    get visible() { return visible; },
    set visible(value: PersonalSnapshot) { visible = value; },
    failNextPersist() { failPersistOnce = true; },
    afterNextPersist(callback: () => void) { afterPersistOnce = callback; },
  };
}

describe('durable account bootstrap persistence', () => {
  test('stages guest bytes after handoff verification and before publishing the binding', async () => {
    let failOnce = true;
    let fixture!: ReturnType<typeof createFixture>;
    const stageTransitionMedia = jest.fn(async () => {
      expect(fixture.storage.values.has(
        `recoto:user:user-a:${ACCOUNT_TRANSITION_MEDIA_DOMAIN}`,
      )).toBe(true);
      expect(fixture.storage.values.has(ACCOUNT_BOOTSTRAP_BINDING_KEY)).toBe(false);
      if (failOnce) {
        failOnce = false;
        throw new Error('staging interrupted');
      }
    });
    fixture = createFixture({ stageTransitionMedia });
    fixture.visible.entries['2026-09-05'].imageUri = 'blob:https://recoto.test/guest';
    const guest = await fixture.ownerStorage.getOwner();
    const rows = await fixture.persistence.readLocalRows(guest);

    await expect(fixture.persistence.beginTransition({
      targetUserId: 'user-a', sourceRows: rows,
    })).rejects.toThrow('staging interrupted');
    expect((await fixture.persistence.readBinding()).pendingTransition).toBeNull();

    await fixture.persistence.beginTransition({ targetUserId: 'user-a', sourceRows: rows });
    expect((await fixture.persistence.readBinding()).pendingTransition?.targetUserId)
      .toBe('user-a');
    expect(stageTransitionMedia).toHaveBeenCalledTimes(2);
  });

  test('hands guest device media to the account durably without putting device URIs in cloud rows', async () => {
    const fixture = createFixture();
    fixture.visible.entries['2026-09-05'].imageUri = 'file:///private/calendar.jpg';
    fixture.visible.entries['2026-09-05'].diaryPhotos = [
      'content://picker/diary-a',
      'file:///private/diary-b.jpg',
    ];
    fixture.visible.stamps.push({
      id: 'photo-stamp',
      text: '',
      bgColor: '#fff',
      textColor: '#000',
      isImageStamp: true,
      imageUri: 'file:///private/stamp.jpg',
    });
    const guest = await fixture.ownerStorage.getOwner();
    const guestRows = await fixture.persistence.readLocalRows(guest);
    expect(JSON.stringify(guestRows)).not.toMatch(/(?:file|content):\/\//);

    await fixture.persistence.beginTransition({ targetUserId: 'user-a', sourceRows: guestRows });
    const mediaKey = `recoto:user:user-a:${ACCOUNT_TRANSITION_MEDIA_DOMAIN}`;
    expect(fixture.storage.values.get(mediaKey)).toContain('file:///private/calendar.jpg');
    expect(fixture.storage.values.get(ACCOUNT_BOOTSTRAP_BINDING_KEY)).not.toContain('file://');
    expect(fixture.storage.values.get(
      `recoto:user:user-a:${ACCOUNT_TRANSITION_SOURCE_DOMAIN}`,
    )).not.toContain('file://');

    await fixture.ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
    fixture.visible = emptyPersonalSnapshot();
    await fixture.persistence.stageSourceRows('user-a', guestRows);
    expect(fixture.visible.entries['2026-09-05']).toMatchObject({
      imageUri: 'file:///private/calendar.jpg',
      diaryPhotos: ['content://picker/diary-a', 'file:///private/diary-b.jpg'],
    });
    expect(fixture.visible.stamps.find((stamp) => stamp.id === 'photo-stamp')?.imageUri)
      .toBe('file:///private/stamp.jpg');

    const cloudRows = guestRows.map((item, index) => ({
      ownerId: 'user-a',
      entity: item.entity ?? 'calendar-entry',
      id: item.id,
      revision: index + 1,
      payload: item.payload,
      updatedAt: '2026-09-05T12:00:00.000Z',
      schemaVersion: 1,
    }));
    await fixture.persistence.commitMigration('user-a', {
      rows: cloudRows,
      conflictBackups: [],
      cursor: 'cursor-media',
      migrationComplete: true,
      syncPhase: 'synced',
    });
    expect(fixture.visible.entries['2026-09-05'].imageUri)
      .toBe('file:///private/calendar.jpg');
    expect(JSON.stringify(JSON.parse(fixture.storage.values.get(
      `recoto:user:user-a:${ACCOUNT_SYNC_STATE_DOMAIN}`,
    )!))).not.toMatch(/(?:file|content):\/\//);
    expect(fixture.storage.values.has(mediaKey)).toBe(true);

    await fixture.persistence.completeTransition('user-a');
    expect(fixture.storage.values.has(mediaKey)).toBe(true);

    await clearAccountTransitionMediaHandoff(fixture.storage, 'user-a');
    expect(fixture.storage.values.has(mediaKey)).toBe(false);
  });

  test('retains current account device media across a cold bootstrap commit', async () => {
    const fixture = createFixture();
    await fixture.ownerStorage.getOwner();
    await fixture.ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
    fixture.visible.entries['2026-09-05'].imageUri = 'file:///private/pending.jpg';
    const remote = snapshot('remote');
    const rows = [{
      ownerId: 'user-a',
      entity: 'calendar-entry' as const,
      id: '2026-09-05',
      revision: 2,
      payload: remote.entries['2026-09-05'] as unknown as Record<string, unknown>,
      updatedAt: '2026-09-05T12:00:00.000Z',
      schemaVersion: 1,
    }];

    await fixture.persistence.commitMigration('user-a', {
      rows,
      conflictBackups: [],
      cursor: 'cursor-account-media',
      migrationComplete: true,
      syncPhase: 'synced',
    });

    expect(fixture.visible.entries['2026-09-05'].imageUri)
      .toBe('file:///private/pending.jpg');
    expect(JSON.stringify(JSON.parse(fixture.storage.values.get(
      `recoto:user:user-a:${ACCOUNT_SYNC_STATE_DOMAIN}`,
    )!))).not.toContain('file:///private/pending.jpg');
  });

  test('recovers the private media handoff after process death and keeps it on a failed stage', async () => {
    const fixture = createFixture();
    fixture.visible.entries['2026-09-05'].imageUri = 'file:///private/restart.jpg';
    const guest = await fixture.ownerStorage.getOwner();
    const rows = await fixture.persistence.readLocalRows(guest);
    await fixture.persistence.beginTransition({ targetUserId: 'user-a', sourceRows: rows });

    const resumed = fixture.recreatePersistence();
    const binding = await resumed.readBinding();
    expect(binding.pendingTransition?.sourceRows).toEqual(rows);
    await fixture.ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
    fixture.visible = emptyPersonalSnapshot();
    fixture.failNextPersist();
    await expect(resumed.stageSourceRows('user-a', rows)).rejects.toThrow('interrupted');
    expect(fixture.storage.values.has(
      `recoto:user:user-a:${ACCOUNT_TRANSITION_MEDIA_DOMAIN}`,
    )).toBe(true);

    await resumed.stageSourceRows('user-a', rows);
    expect(fixture.visible.entries['2026-09-05'].imageUri)
      .toBe('file:///private/restart.jpg');
  });

  test('retargets a pending A transition to B without exposing or retaining A handoff data', async () => {
    const fixture = createFixture();
    fixture.visible.entries['2026-09-05'].imageUri = 'file:///private/guest.jpg';
    const guest = await fixture.ownerStorage.getOwner();
    const rows = await fixture.persistence.readLocalRows(guest);
    await fixture.persistence.beginTransition({ targetUserId: 'user-a', sourceRows: rows });
    const aKey = `recoto:user:user-a:${ACCOUNT_TRANSITION_MEDIA_DOMAIN}`;
    const bKey = `recoto:user:user-b:${ACCOUNT_TRANSITION_MEDIA_DOMAIN}`;
    expect(fixture.storage.values.has(aKey)).toBe(true);

    await fixture.persistence.beginTransition({ targetUserId: 'user-b', sourceRows: rows });
    expect(fixture.storage.values.has(aKey)).toBe(false);
    expect(fixture.storage.values.get(bKey)).toContain('file:///private/guest.jpg');
    await expect(fixture.persistence.completeTransition('user-a'))
      .rejects.toThrow(/does not match/i);
    expect(fixture.storage.values.has(bKey)).toBe(true);

    await fixture.persistence.clearAccountBinding();
    expect(fixture.storage.values.has(bKey)).toBe(false);
  });

  test('drops a completed A handoff when auth switches directly to B', async () => {
    const fixture = createFixture();
    fixture.visible.entries['2026-09-05'].imageUri = 'file:///private/user-a.jpg';
    const guest = await fixture.ownerStorage.getOwner();
    const rows = await fixture.persistence.readLocalRows(guest);
    await fixture.persistence.beginTransition({ targetUserId: 'user-a', sourceRows: rows });
    await fixture.persistence.completeTransition('user-a');
    const aKey = `recoto:user:user-a:${ACCOUNT_TRANSITION_MEDIA_DOMAIN}`;
    const bKey = `recoto:user:user-b:${ACCOUNT_TRANSITION_MEDIA_DOMAIN}`;
    expect(fixture.storage.values.has(aKey)).toBe(true);

    await fixture.persistence.beginTransition({ targetUserId: 'user-b', sourceRows: null });

    expect(fixture.storage.values.has(aKey)).toBe(false);
    expect(fixture.storage.values.has(bKey)).toBe(false);
  });

  test('stores transition recovery globally and sync state/backups only in the selected user namespace', async () => {
    const fixture = createFixture();
    const guest = await fixture.ownerStorage.getOwner();
    const guestRows = await fixture.persistence.readLocalRows(guest);

    expect(guestRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'calendar-entry', id: '2026-09-05' }),
      expect.objectContaining({ entity: 'preference', id: 'preferences' }),
      expect.objectContaining({ entity: 'stamp', id: 'work' }),
    ]));
    expect(guestRows.every((item) => item.ownerId === undefined)).toBe(true);

    await fixture.persistence.beginTransition({ targetUserId: 'user-a', sourceRows: guestRows });
    const rawBinding = fixture.storage.values.get(ACCOUNT_BOOTSTRAP_BINDING_KEY)!;
    expect(JSON.parse(rawBinding)).toMatchObject({
      activeAccountId: null,
      pendingTransition: { targetUserId: 'user-a' },
    });
    expect(rawBinding).not.toContain('guest');
    expect(fixture.storage.values.has(
      `recoto:user:user-a:${ACCOUNT_TRANSITION_SOURCE_DOMAIN}`,
    )).toBe(true);

    await fixture.ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
    const cloudRows = guestRows.map((item, index) => ({
      ownerId: 'user-a',
      entity: item.entity ?? 'calendar-entry',
      id: item.id,
      revision: index + 1,
      payload: item.payload,
      updatedAt: '2026-09-05T12:00:00.000Z',
      schemaVersion: 1,
    }));
    await fixture.persistence.persistLocalBackup('user-a', cloudRows);
    await fixture.persistence.commitMigration('user-a', {
      rows: cloudRows,
      conflictBackups: [cloudRows[0]],
      cursor: 'cursor-a',
      migrationComplete: true,
      syncPhase: 'conflict-backed-up',
    });
    await fixture.persistence.completeTransition('user-a');

    const prefix = 'recoto:user:user-a:';
    expect(fixture.storage.values.has(prefix + ACCOUNT_LOCAL_BACKUP_DOMAIN)).toBe(true);
    expect(fixture.storage.values.has(prefix + ACCOUNT_CONFLICT_BACKUP_DOMAIN)).toBe(true);
    expect(JSON.parse(fixture.storage.values.get(prefix + ACCOUNT_SYNC_STATE_DOMAIN)!)).toMatchObject({
      ownerId: 'user-a',
      cursor: 'cursor-a',
      migrationComplete: true,
      syncPhase: 'conflict-backed-up',
      lastSyncedAt: '2026-09-05T12:00:00.000Z',
    });
    await expect(fixture.persistence.readBinding()).resolves.toEqual({
      activeAccountId: 'user-a',
      pendingTransition: null,
    });
    expect(fixture.storage.values.has(
      `recoto:user:user-a:${ACCOUNT_TRANSITION_SOURCE_DOMAIN}`,
    )).toBe(false);
    expect([...fixture.storage.values.keys()].some((key) => key.includes('guest') && key.includes('backup'))).toBe(false);
  });

  test('an interrupted multi-key commit remains journaled and is completed on recovery', async () => {
    const fixture = createFixture();
    await fixture.ownerStorage.getOwner();
    await fixture.ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
    const remote = snapshot('authoritative remote');
    remote.specialDates = [{
      id: 'remote-anniversary',
      name: '記念日',
      month: 9,
      day: 5,
      color: '#f00',
      type: 'anniversary',
    }];
    const rows = [
      {
        ownerId: 'user-a',
        entity: 'calendar-entry' as const,
        id: '2026-09-05',
        revision: 2,
        payload: remote.entries['2026-09-05'] as unknown as Record<string, unknown>,
        updatedAt: '2026-09-05T12:00:00.000Z',
        schemaVersion: 1,
      },
      {
        ownerId: 'user-a',
        entity: 'special-date' as const,
        id: 'remote-anniversary',
        revision: 3,
        payload: remote.specialDates[0] as unknown as Record<string, unknown>,
        updatedAt: '2026-09-05T12:00:00.000Z',
        schemaVersion: 1,
      },
    ];
    fixture.failNextPersist();

    await expect(fixture.persistence.commitMigration('user-a', {
      rows,
      conflictBackups: [],
      cursor: 'cursor-2',
      migrationComplete: true,
      syncPhase: 'synced',
    })).rejects.toThrow('interrupted');

    const journalKey = `recoto:user:user-a:${ACCOUNT_COMMIT_JOURNAL_DOMAIN}`;
    expect(fixture.storage.values.has(journalKey)).toBe(true);
    expect(fixture.visible.entries['2026-09-05'].notes).toBe('guest');

    await fixture.persistence.recoverOwner('user-a');
    expect(fixture.visible.entries['2026-09-05'].notes).toBe('authoritative remote');
    expect(fixture.storage.values.has(journalKey)).toBe(false);
    expect(JSON.parse(
      fixture.storage.values.get(`recoto:user:user-a:${ACCOUNT_SYNC_STATE_DOMAIN}`)!,
    )).toMatchObject({ cursor: 'cursor-2', migrationComplete: true });
  });

  test('keeps a newer local edit when it arrives during a runtime remote commit', async () => {
    const fixture = createFixture();
    await fixture.ownerStorage.getOwner();
    await fixture.ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
    const remote = snapshot('authoritative remote');
    remote.specialDates = [{
      id: 'remote-anniversary',
      name: '記念日',
      month: 9,
      day: 5,
      color: '#f00',
      type: 'anniversary',
    }];
    const rows = [
      {
        ownerId: 'user-a',
        entity: 'calendar-entry' as const,
        id: '2026-09-05',
        revision: 2,
        payload: remote.entries['2026-09-05'] as unknown as Record<string, unknown>,
        updatedAt: '2026-09-05T12:00:00.000Z',
        schemaVersion: 1,
      },
      {
        ownerId: 'user-a',
        entity: 'special-date' as const,
        id: 'remote-anniversary',
        revision: 3,
        payload: remote.specialDates[0] as unknown as Record<string, unknown>,
        updatedAt: '2026-09-05T12:00:00.000Z',
        schemaVersion: 1,
      },
    ];
    let localChanged = false;
    fixture.afterNextPersist(() => {
      fixture.visible = snapshot('newer local edit');
      localChanged = true;
    });
    const publishCalls = jest.fn();
    const guard: AccountRuntimePublishGuard = {
      isCurrent: () => true,
      canPublish: () => !localChanged,
      runWhilePublishing<T>(publish: () => T) {
        publishCalls();
        return publish();
      },
    };

    await expect(fixture.persistence.commitRuntimeSync('user-a', {
      rows,
      conflictBackups: [],
      cursor: 'cursor-2',
      migrationComplete: true,
      syncPhase: 'synced',
    }, remote, guard)).resolves.toBe(false);

    expect(publishCalls).toHaveBeenCalledTimes(1);
    expect(fixture.visible.entries['2026-09-05'].notes).toBe('newer local edit');
    expect(fixture.visible.specialDates).toEqual([
      expect.objectContaining({ id: 'remote-anniversary' }),
    ]);
    const prefix = 'recoto:user:user-a:';
    expect(JSON.parse(fixture.storage.values.get(`${prefix}test-snapshot`)!))
      .toMatchObject({ entries: { '2026-09-05': { notes: 'newer local edit' } } });
    expect(JSON.parse(fixture.storage.values.get(`${prefix}${ACCOUNT_SYNC_STATE_DOMAIN}`)!))
      .toMatchObject({ cursor: 'cursor-2', rows });
    expect(fixture.storage.values.has(`${prefix}${ACCOUNT_COMMIT_JOURNAL_DOMAIN}`)).toBe(false);
  });

  test('never publishes into visible stores after the producer generation is invalidated', async () => {
    const fixture = createFixture();
    await fixture.ownerStorage.getOwner();
    await fixture.ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
    const remote = snapshot('remote after switch');
    const rows = [{
      ownerId: 'user-a',
      entity: 'calendar-entry' as const,
      id: '2026-09-05',
      revision: 2,
      payload: remote.entries['2026-09-05'] as unknown as Record<string, unknown>,
      updatedAt: '2026-09-05T12:00:00.000Z',
      schemaVersion: 1,
    }];
    let current = true;
    fixture.afterNextPersist(() => { current = false; });
    const publishCalls = jest.fn();

    await expect(fixture.persistence.commitRuntimeSync('user-a', {
      rows,
      conflictBackups: [],
      cursor: 'cursor-2',
      migrationComplete: true,
      syncPhase: 'synced',
    }, remote, {
      isCurrent: () => current,
      canPublish: () => current,
      runWhilePublishing<T>(publish: () => T) {
        publishCalls();
        return publish();
      },
    })).resolves.toBe(false);

    expect(publishCalls).not.toHaveBeenCalled();
    expect(fixture.visible.entries['2026-09-05'].notes).toBe('guest');
    expect(fixture.storage.values.has(
      `recoto:user:user-a:${ACCOUNT_COMMIT_JOURNAL_DOMAIN}`,
    )).toBe(true);
  });

  test('owner assertion prevents reading A metadata while B is selected', async () => {
    const fixture = createFixture();
    await fixture.ownerStorage.getOwner();
    await fixture.ownerStorage.switchOwner({ kind: 'user', id: 'user-b' });

    await expect(fixture.persistence.recoverOwner('user-a')).rejects.toThrow('active owner');
  });

  test('rejects malformed remote payloads before publishing them to local stores', async () => {
    const fixture = createFixture();
    await fixture.ownerStorage.getOwner();
    await fixture.ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });

    await expect(fixture.persistence.commitMigration('user-a', {
      rows: [{
        ownerId: 'user-a',
        entity: 'calendar-entry',
        id: '2026-09-05',
        revision: 1,
        payload: { date: '2026-09-05', miniStamps: {}, privacyLevel: '2' },
        updatedAt: '2026-09-05T12:00:00.000Z',
        schemaVersion: 1,
      }],
      conflictBackups: [],
      cursor: 'cursor-corrupt',
      migrationComplete: true,
      syncPhase: 'synced',
    })).rejects.toThrow('Invalid calendar entry');

    expect(fixture.visible.entries['2026-09-05'].notes).toBe('guest');
  });

  test('the durable owner outbox is a real flush boundary and persists its resulting state', async () => {
    const fixture = createFixture();
    await fixture.ownerStorage.getOwner();
    await fixture.ownerStorage.switchOwner({ kind: 'user', id: 'user-a' });
    const stateStorage = createOwnerStateStorage(fixture.ownerStorage);
    await stateStorage.setItem(ACCOUNT_OUTBOX_DOMAIN, JSON.stringify([]));
    const outbox = createAccountBootstrapOutbox({
      ownerStorage: fixture.ownerStorage,
      now: () => new Date('2026-09-05T12:00:00.000Z'),
    });

    await expect(outbox.flush(
      'user-a',
      createMemoryCloudRepository([], { defaultOwnerId: 'user-a' }),
    )).resolves.toEqual({ syncPhase: 'synced' });

    expect(JSON.parse(
      fixture.storage.values.get(`recoto:user:user-a:${ACCOUNT_OUTBOX_DOMAIN}`)!,
    )).toEqual([]);
  });
});
