import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StateStorage } from 'zustand/middleware';
import {
  createCalendarOwnerSwitchTarget,
  useCalendarStore,
} from '../../store/calendarStore';
import { useLocaleStore } from '../../store/localeStore';
import { createStampOwnerSwitchTarget, useStampStore } from '../../store/stampStore';
import { createTripOwnerSwitchTarget, useTripStore } from '../../store/tripStore';
import {
  CURRENT_PERSONAL_SCHEMA_VERSION,
  type CloudEntity,
  type OutboxMutation,
  type PersonalSnapshot,
  type PortableCalendarEntry,
  type PortablePreferences,
  type PortableSpecialDate,
  type PortableStamp,
  type PortableTrip,
  type PortableTripItem,
} from '../../types/account';
import type { DayEntry, RecurringSchedule, SpecialDate, Stamp } from '../../types';
import type { Trip, TripItem } from '../../types/travel';
import {
  createOwnerStateStorage,
  getPersonalOwnerStorage,
  switchOwnerAndRehydrate,
  type DataOwner,
  type KeyValueStorage,
  type OwnerStorage,
} from './namespacedStorage';
import {
  createPortableSnapshot,
  type PersonalSnapshotInput,
} from './personalSnapshot';
import {
  assertActiveTripGraph,
  tripFromCloudPayload,
  tripItemFromCloudPayload,
  tripItemToCloudPayload,
  tripToCloudPayload,
} from './tripMapper';
import { createProductionPersonalMediaTransitionStager } from './productionPersonalMediaTransitionStaging';
import {
  requireCurrentPersonalSchemaVersion,
  type CloudRepository,
  type CloudRow,
  type CloudRowSeed,
} from './cloudRepository';
import type {
  AccountBootstrapBinding,
  AccountBootstrapOutbox,
  AccountBootstrapPersistence,
} from './accountBootstrap';
import {
  flushOutbox,
  type MigrationCompletion,
  type OutboxConflictBackup,
} from './syncEngine';

export const ACCOUNT_BOOTSTRAP_BINDING_KEY = 'recoto:account-bootstrap-binding:v1';
export const ACCOUNT_TRANSITION_SOURCE_DOMAIN = 'account-transition-source-v1';
export const ACCOUNT_TRANSITION_MEDIA_DOMAIN = 'account-transition-media-v1';
export const ACCOUNT_SYNC_STATE_DOMAIN = 'account-sync-state-v1';
export const ACCOUNT_LOCAL_BACKUP_DOMAIN = 'account-local-backup-v1';
export const ACCOUNT_CONFLICT_BACKUP_DOMAIN = 'account-conflict-backup-v1';
export const ACCOUNT_OUTBOX_CONFLICT_BACKUP_DOMAIN = 'account-outbox-conflict-backup-v1';
export const ACCOUNT_COMMIT_JOURNAL_DOMAIN = 'account-commit-journal-v1';
export const ACCOUNT_OUTBOX_DOMAIN = 'account-outbox-v1';

interface DurableSyncState {
  version: 1;
  ownerId: string;
  cursor: string;
  lastSyncedAt: string;
  migrationComplete: true;
  syncPhase: MigrationCompletion['syncPhase'];
  rows: CloudRow[];
}

interface CommitJournal {
  version: 1;
  ownerId: string;
  snapshot: PersonalSnapshot;
  completion: MigrationCompletion;
  committedAt: string;
}

interface TransitionMediaSnapshot {
  version: 1;
  targetUserId: string;
  entries: Record<string, {
    imageUri?: string;
    diaryPhotos?: string[];
  }>;
  stamps: Record<string, string>;
}

export interface AccountBootstrapLocalBridge {
  readSnapshot(): PersonalSnapshot;
  /** Includes device-local media while a guarded runtime cache commit is in flight. */
  readRuntimeSnapshot?(): PersonalSnapshot;
  /** Persists every owner-scoped store before in-memory state is published. */
  persistSnapshot(snapshot: PersonalSnapshot): Promise<void>;
  /** Writes an explicit user namespace so an owner switch cannot redirect it. */
  persistRuntimeSnapshot?(ownerId: string, snapshot: PersonalSnapshot): Promise<void>;
  replaceSnapshot(snapshot: PersonalSnapshot): void;
}

export interface AccountRuntimePublishGuard {
  isCurrent(): boolean;
  canPublish(): boolean;
  runWhilePublishing<T>(publish: () => T): T;
}

/** Runtime-only extension that keeps a newer local edit ahead of a remote refresh. */
export interface AccountRuntimeSyncPersistence {
  commitRuntimeSync(
    ownerId: string,
    completion: MigrationCompletion,
    snapshot: PersonalSnapshot,
    guard: AccountRuntimePublishGuard,
  ): Promise<boolean>;
}

interface PersistenceOptions {
  storage: KeyValueStorage;
  ownerStorage: OwnerStorage;
  local: AccountBootstrapLocalBridge;
  stageTransitionMedia?(ownerId: string, snapshot: PersonalSnapshot): Promise<void>;
  now?: () => Date;
}

const CLOUD_ENTITIES = new Set<CloudEntity>([
  'calendar-entry',
  'special-date',
  'preference',
  'stamp',
  'trip',
  'trip-item',
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}`);
  return value;
}

function parseCloudRowSeed(value: unknown): CloudRowSeed {
  if (!isRecord(value)) throw new Error('Invalid bootstrap row');
  const id = requireNonEmptyString(value.id, 'bootstrap row id');
  const revision = value.revision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
    throw new Error('Invalid bootstrap row revision');
  }
  if (value.payload !== null && !isRecord(value.payload)) {
    throw new Error('Invalid bootstrap row payload');
  }
  const entity = value.entity;
  if (entity !== undefined && (typeof entity !== 'string' || !CLOUD_ENTITIES.has(entity as CloudEntity))) {
    throw new Error('Invalid bootstrap row entity');
  }
  const ownerId = value.ownerId;
  if (ownerId !== undefined) requireNonEmptyString(ownerId, 'bootstrap row owner');
  const updatedAt = value.updatedAt;
  if (updatedAt !== undefined) requireNonEmptyString(updatedAt, 'bootstrap row timestamp');
  const deletedAt = value.deletedAt;
  if (deletedAt !== undefined) requireNonEmptyString(deletedAt, 'bootstrap row deletion timestamp');
  const schemaVersion = requireCurrentPersonalSchemaVersion(
    value.schemaVersion ?? value.schema_version,
    `Bootstrap row ${id}`,
  );
  return { ...clone(value), schemaVersion } as unknown as CloudRowSeed;
}

function parseCloudRows(value: unknown): CloudRow[] {
  if (!Array.isArray(value)) throw new Error('Invalid cloud row list');
  return value.map((item) => {
    const seed = parseCloudRowSeed(item);
    if (!seed.ownerId || !seed.entity || !seed.updatedAt) throw new Error('Incomplete cloud row');
    return seed as CloudRow;
  });
}

interface StoredBinding {
  activeAccountId: string | null;
  pendingTransition: {
    targetUserId: string;
    hasSourceRows: boolean;
    legacySourceRows: CloudRowSeed[] | null;
  } | null;
}

function parseStoredBinding(raw: string | null): StoredBinding {
  if (raw === null) return { activeAccountId: null, pendingTransition: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid account bootstrap binding');
  }
  if (!isRecord(value)) throw new Error('Invalid account bootstrap binding');
  const active = value.activeAccountId;
  if (active !== null && typeof active !== 'string') {
    throw new Error('Invalid active account binding');
  }
  const pending = value.pendingTransition;
  if (pending !== null && !isRecord(pending)) {
    throw new Error('Invalid pending account transition');
  }
  return {
    activeAccountId: active === null ? null : requireNonEmptyString(active, 'active account'),
    pendingTransition: pending === null
      ? null
      : {
          targetUserId: requireNonEmptyString(pending.targetUserId, 'pending account'),
          hasSourceRows: pending.hasSourceRows === true || Array.isArray(pending.sourceRows),
          legacySourceRows: Array.isArray(pending.sourceRows)
            ? pending.sourceRows.map(parseCloudRowSeed)
            : null,
        },
  };
}

function transitionSourceKey(userId: string) {
  const safeUserId = requireNonEmptyString(userId, 'transition owner');
  if (safeUserId.includes(':')) throw new Error('Invalid transition owner');
  return `recoto:user:${safeUserId}:${ACCOUNT_TRANSITION_SOURCE_DOMAIN}`;
}

function transitionMediaKey(userId: string) {
  const safeUserId = requireNonEmptyString(userId, 'transition media owner');
  if (safeUserId.includes(':')) throw new Error('Invalid transition media owner');
  return `recoto:user:${safeUserId}:${ACCOUNT_TRANSITION_MEDIA_DOMAIN}`;
}

function userDomainKey(userId: string, domain: string) {
  const safeUserId = requireNonEmptyString(userId, 'user storage owner');
  const safeDomain = requireNonEmptyString(domain, 'user storage domain');
  if (safeUserId.includes(':') || safeDomain.includes(':')) {
    throw new Error('Invalid user storage key');
  }
  return `recoto:user:${safeUserId}:${safeDomain}`;
}

function createExplicitUserStateStorage(
  storage: KeyValueStorage,
  ownerId: string,
): StateStorage {
  return {
    getItem: (domain) => storage.getItem(userDomainKey(ownerId, domain)),
    setItem: (domain, value) => storage.setItem(userDomainKey(ownerId, domain), value),
    removeItem: (domain) => storage.removeItem(userDomainKey(ownerId, domain)),
  };
}

function isDeviceMediaUri(value: unknown): value is string {
  return typeof value === 'string'
    && /^(?:(?:file|content|blob):|data:image\/)/i.test(value);
}

function extractTransitionMedia(
  snapshot: PersonalSnapshot,
  targetUserId: string,
): TransitionMediaSnapshot {
  const entries: TransitionMediaSnapshot['entries'] = {};
  for (const [id, entry] of Object.entries(snapshot.entries)) {
    const media: TransitionMediaSnapshot['entries'][string] = {};
    if (isDeviceMediaUri(entry.imageUri)) media.imageUri = entry.imageUri;
    if (entry.diaryPhotos?.some(isDeviceMediaUri)) {
      // Preserve positions around a device URI; portable snapshots filter values
      // and would otherwise shift the remaining photo into the wrong slot.
      media.diaryPhotos = entry.diaryPhotos.filter(
        (value): value is string => typeof value === 'string',
      );
    }
    if (media.imageUri || media.diaryPhotos) entries[id] = media;
  }
  const stamps: Record<string, string> = {};
  snapshot.stamps.forEach((stamp) => {
    if (isDeviceMediaUri(stamp.imageUri)) stamps[stamp.id] = stamp.imageUri;
  });
  return { version: 1, targetUserId, entries, stamps };
}

function parseTransitionMedia(
  value: unknown,
  targetUserId: string,
): TransitionMediaSnapshot {
  if (
    !isRecord(value)
    || value.version !== 1
    || value.targetUserId !== targetUserId
    || !isRecord(value.entries)
    || !isRecord(value.stamps)
  ) throw new Error('Invalid pending transition media');
  const entries: TransitionMediaSnapshot['entries'] = {};
  for (const [id, raw] of Object.entries(value.entries)) {
    if (!id || !isRecord(raw)) throw new Error('Invalid pending transition media');
    const imageUri = raw.imageUri;
    const diaryPhotos = raw.diaryPhotos;
    if (imageUri !== undefined && !isDeviceMediaUri(imageUri)) {
      throw new Error('Invalid pending transition media');
    }
    if (
      diaryPhotos !== undefined
      && (
        !Array.isArray(diaryPhotos)
        || !diaryPhotos.every((uri) => typeof uri === 'string')
        || !diaryPhotos.some(isDeviceMediaUri)
      )
    ) throw new Error('Invalid pending transition media');
    if (imageUri === undefined && diaryPhotos === undefined) {
      throw new Error('Invalid pending transition media');
    }
    entries[id] = {
      ...(typeof imageUri === 'string' ? { imageUri } : {}),
      ...(Array.isArray(diaryPhotos) ? { diaryPhotos: [...diaryPhotos] as string[] } : {}),
    };
  }
  const stamps: Record<string, string> = {};
  for (const [id, uri] of Object.entries(value.stamps)) {
    if (!id || !isDeviceMediaUri(uri)) throw new Error('Invalid pending transition media');
    stamps[id] = uri;
  }
  return { version: 1, targetUserId, entries, stamps };
}

function overlayTransitionMedia(
  snapshot: PersonalSnapshot,
  media: TransitionMediaSnapshot,
): PersonalSnapshot {
  const result = clone(snapshot);
  for (const [id, fields] of Object.entries(media.entries)) {
    const entry = result.entries[id];
    if (!entry) continue;
    if (fields.imageUri) entry.imageUri = fields.imageUri;
    if (fields.diaryPhotos) entry.diaryPhotos = [...fields.diaryPhotos];
  }
  for (const [id, imageUri] of Object.entries(media.stamps)) {
    const stamp = result.stamps.find((candidate) => candidate.id === id);
    if (stamp) stamp.imageUri = imageUri;
  }
  return result;
}

async function readTransitionMedia(
  storage: KeyValueStorage,
  targetUserId: string,
): Promise<TransitionMediaSnapshot | null> {
  const raw = await storage.getItem(transitionMediaKey(targetUserId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid pending transition media');
  }
  return parseTransitionMedia(parsed, targetUserId);
}

/** Clears guest handoff metadata only after every source has a durable media job. */
export async function clearAccountTransitionMediaHandoff(
  storage: KeyValueStorage,
  ownerId: string,
): Promise<void> {
  const key = transitionMediaKey(ownerId);
  await storage.removeItem(key);
  if (await storage.getItem(key) !== null) {
    throw new Error('Pending transition media could not be cleared');
  }
}

/** Returns only local media references from the strictly owner-bound handoff. */
export async function readAccountTransitionMediaHandoffUris(
  storage: KeyValueStorage,
  ownerId: string,
): Promise<string[]> {
  const media = await readTransitionMedia(storage, ownerId);
  if (!media) return [];
  return [
    ...Object.values(media.entries).flatMap((entry) => [
      ...(entry.imageUri ? [entry.imageUri] : []),
      ...(entry.diaryPhotos ?? []).filter(isDeviceMediaUri),
    ]),
    ...Object.values(media.stamps),
  ];
}

async function readBinding(storage: KeyValueStorage): Promise<AccountBootstrapBinding> {
  const stored = parseStoredBinding(await storage.getItem(ACCOUNT_BOOTSTRAP_BINDING_KEY));
  if (!stored.pendingTransition) {
    return { activeAccountId: stored.activeAccountId, pendingTransition: null };
  }
  const pending = stored.pendingTransition;
  let sourceRows = pending.legacySourceRows;
  if (sourceRows === null && pending.hasSourceRows) {
    const rawRows = await storage.getItem(transitionSourceKey(pending.targetUserId));
    if (rawRows === null) throw new Error('Pending transition source is missing');
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawRows);
    } catch {
      throw new Error('Invalid pending transition source');
    }
    if (!Array.isArray(parsed)) throw new Error('Invalid pending transition source');
    sourceRows = parsed.map(parseCloudRowSeed);
  }
  return {
    activeAccountId: stored.activeAccountId,
    pendingTransition: {
      targetUserId: pending.targetUserId,
      sourceRows: sourceRows ? clone(sourceRows) : null,
    },
  };
}

async function readJson(stateStorage: StateStorage, key: string): Promise<unknown | null> {
  const raw = await stateStorage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid persisted ${key}`);
  }
}

function rowKey(entity: CloudEntity, id: string) {
  return `${entity}\u0000${id}`;
}

function payloadRecord(row: CloudRow): Record<string, unknown> {
  if (!row.payload || !isRecord(row.payload)) {
    throw new Error(`Cloud row ${row.entity}:${row.id} has no valid payload`);
  }
  return clone(row.payload);
}

function optionalValueHasType(
  record: Record<string, unknown>,
  key: string,
  type: 'string' | 'boolean' | 'number',
) {
  return record[key] === undefined || typeof record[key] === type;
}

function validMiniStamps(value: unknown) {
  return isRecord(value)
    && optionalValueHasType(value, 'left', 'string')
    && optionalValueHasType(value, 'right', 'string');
}

function validNoteItems(value: unknown) {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((item) => isRecord(item)
    && typeof item.id === 'string'
    && typeof item.text === 'string'
    && ['time', 'endTime', 'fromTimeSlotId', 'color', 'url', 'fromGoogleId']
      .every((key) => optionalValueHasType(item, key, 'string'))
    && ['notificationEnabled', 'syncToGoogle']
      .every((key) => optionalValueHasType(item, key, 'boolean'))
    && (
      item.googleSyncDirection === undefined
      || ['none', 'toGoogle', 'fromGoogle', 'both'].includes(String(item.googleSyncDirection))
    ));
}

function validTimeSlots(value: unknown) {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((slot) => isRecord(slot)
    && ['id', 'startTime', 'endTime', 'title', 'color'].every((key) => typeof slot[key] === 'string')
    && optionalValueHasType(slot, 'url', 'string')
    && optionalValueHasType(slot, 'notificationEnabled', 'boolean')
    && optionalValueHasType(slot, 'reflectToMonthly', 'boolean'));
}

function calendarEntry(row: CloudRow): PortableCalendarEntry {
  const payload = payloadRecord(row);
  if (
    (payload.date !== undefined && payload.date !== row.id)
    || !validMiniStamps(payload.miniStamps)
    || typeof payload.privacyLevel !== 'number'
    || ![0, 1, 2, 3].includes(payload.privacyLevel)
    || !['mainStampId', 'notes', 'startTime', 'endTime', 'imageUri', 'diary', 'dailyGoal']
      .every((key) => optionalValueHasType(payload, key, 'string'))
    || !['notificationEnabled', 'diaryConfirmed']
      .every((key) => optionalValueHasType(payload, key, 'boolean'))
    || !validNoteItems(payload.noteItems)
    || !validTimeSlots(payload.timeSlots)
    || (
      payload.diaryPhotos !== undefined
      && (!Array.isArray(payload.diaryPhotos) || !payload.diaryPhotos.every((item) => typeof item === 'string'))
    )
  ) {
    throw new Error(`Invalid calendar entry ${row.id}`);
  }
  return { ...payload, date: row.id } as unknown as PortableCalendarEntry;
}

function specialDate(row: CloudRow): PortableSpecialDate {
  const payload = payloadRecord(row);
  if (
    (payload.id !== undefined && payload.id !== row.id)
    || typeof payload.name !== 'string'
    || !Number.isInteger(payload.month) || Number(payload.month) < 1 || Number(payload.month) > 12
    || !Number.isInteger(payload.day) || Number(payload.day) < 1 || Number(payload.day) > 31
    || typeof payload.color !== 'string'
    || !['birthday', 'anniversary', 'other'].includes(String(payload.type))
    || !optionalValueHasType(payload, 'emoji', 'string')
  ) throw new Error(`Invalid special date ${row.id}`);
  return { ...payload, id: row.id } as unknown as PortableSpecialDate;
}

function stamp(row: CloudRow): PortableStamp {
  const payload = payloadRecord(row);
  if (
    (payload.id !== undefined && payload.id !== row.id)
    || typeof payload.text !== 'string'
    || typeof payload.bgColor !== 'string'
    || typeof payload.textColor !== 'string'
    || !['isDefault', 'isMain', 'isEnabled', 'isImageStamp']
      .every((key) => optionalValueHasType(payload, key, 'boolean'))
    || !optionalValueHasType(payload, 'imageUri', 'string')
  ) throw new Error(`Invalid stamp ${row.id}`);
  return { ...payload, id: row.id } as unknown as PortableStamp;
}

function preferences(row: CloudRow): PortablePreferences {
  if (row.id !== 'preferences') throw new Error('Invalid preferences id');
  const payload = payloadRecord(row);
  if (payload.weekStartDay !== undefined && payload.weekStartDay !== 0 && payload.weekStartDay !== 1) {
    throw new Error('Invalid week start preference');
  }
  if (payload.locale !== undefined && payload.locale !== 'ja' && payload.locale !== 'en') {
    throw new Error('Invalid locale preference');
  }
  if (payload.recurringSchedules !== undefined && (
    !Array.isArray(payload.recurringSchedules)
    || !payload.recurringSchedules.every((schedule) => isRecord(schedule)
      && ['id', 'name', 'stampId'].every((key) => typeof schedule[key] === 'string')
      && ['main', 'mini-left', 'mini-right'].includes(String(schedule.stampPosition))
      && Array.isArray(schedule.daysOfWeek)
      && schedule.daysOfWeek.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      && (
        schedule.appliedMonths === undefined
        || (Array.isArray(schedule.appliedMonths)
          && schedule.appliedMonths.every((month) => typeof month === 'string'))
      ))
  )) throw new Error('Invalid recurring schedule preference');
  return payload as PortablePreferences;
}

function trip(row: CloudRow): PortableTrip {
  return tripFromCloudPayload(row.id, payloadRecord(row));
}

function tripItem(row: CloudRow): PortableTripItem {
  return tripItemFromCloudPayload(row.id, payloadRecord(row));
}

export function snapshotFromCloudRows(rows: readonly CloudRow[]): PersonalSnapshot {
  const snapshot: PersonalSnapshot = {
    entries: {},
    specialDates: [],
    preferences: {},
    stamps: [],
    trips: [],
    tripItems: [],
  };
  for (const row of rows) {
    requireCurrentPersonalSchemaVersion(row.schemaVersion, `Cloud row ${row.entity}:${row.id}`);
    if (row.deletedAt) continue;
    switch (row.entity) {
      case 'calendar-entry':
        snapshot.entries[row.id] = calendarEntry(row);
        break;
      case 'special-date':
        snapshot.specialDates.push(specialDate(row));
        break;
      case 'preference':
        snapshot.preferences = preferences(row);
        break;
      case 'stamp':
        snapshot.stamps.push(stamp(row));
        break;
      case 'trip':
        snapshot.trips.push(trip(row));
        break;
      case 'trip-item':
        snapshot.tripItems.push(tripItem(row));
        break;
    }
  }
  assertActiveTripGraph(
    snapshot.trips as unknown as Trip[],
    snapshot.tripItems as unknown as TripItem[],
  );
  return snapshot;
}

function seedForPayload(
  owner: DataOwner,
  entity: CloudEntity,
  id: string,
  payload: Record<string, unknown>,
  metadata: ReadonlyMap<string, CloudRow>,
  now: string,
): CloudRowSeed {
  const previous = metadata.get(rowKey(entity, id));
  const schemaVersion = requireCurrentPersonalSchemaVersion(
    previous?.schemaVersion,
    `Cloud row ${entity}:${id}`,
  );
  return {
    ...(owner.kind === 'user' ? { ownerId: owner.id } : {}),
    entity,
    id,
    revision: previous?.revision ?? 1,
    payload: clone(payload),
    updatedAt: previous?.updatedAt ?? now,
    schemaVersion,
  };
}

export function snapshotToCloudRows(
  owner: DataOwner,
  snapshot: PersonalSnapshot,
  previousRows: readonly CloudRow[],
  now: string,
): CloudRowSeed[] {
  previousRows.forEach((row) => {
    requireCurrentPersonalSchemaVersion(row.schemaVersion, `Cloud row ${row.entity}:${row.id}`);
  });
  const normalizedTrips = snapshot.trips.map((value) => tripToCloudPayload(value as Trip));
  const normalizedTripItems = snapshot.tripItems.map(
    (value) => tripItemToCloudPayload(value as TripItem),
  );
  assertActiveTripGraph(
    normalizedTrips as unknown as Trip[],
    normalizedTripItems as unknown as TripItem[],
  );
  const metadata = new Map(previousRows.map((row) => [rowKey(row.entity, row.id), row]));
  const rows: CloudRowSeed[] = [];
  Object.entries(snapshot.entries).forEach(([id, payload]) => {
    rows.push(seedForPayload(owner, 'calendar-entry', id, payload as unknown as Record<string, unknown>, metadata, now));
  });
  snapshot.specialDates.forEach((payload) => {
    rows.push(seedForPayload(owner, 'special-date', payload.id, payload as unknown as Record<string, unknown>, metadata, now));
  });
  rows.push(seedForPayload(
    owner,
    'preference',
    'preferences',
    snapshot.preferences as Record<string, unknown>,
    metadata,
    now,
  ));
  snapshot.stamps.forEach((payload) => {
    rows.push(seedForPayload(owner, 'stamp', payload.id, payload as unknown as Record<string, unknown>, metadata, now));
  });
  normalizedTrips.forEach((payload) => {
    rows.push(seedForPayload(owner, 'trip', payload.id, payload as unknown as Record<string, unknown>, metadata, now));
  });
  normalizedTripItems.forEach((payload) => {
    rows.push(seedForPayload(owner, 'trip-item', payload.id, payload as unknown as Record<string, unknown>, metadata, now));
  });
  return rows;
}

function parseSyncState(value: unknown, ownerId: string): DurableSyncState | null {
  if (value === null) return null;
  if (!isRecord(value) || value.version !== 1 || value.ownerId !== ownerId) {
    throw new Error('Invalid owner sync state');
  }
  if (
    typeof value.cursor !== 'string'
    || typeof value.lastSyncedAt !== 'string'
    || value.migrationComplete !== true
    || !['synced', 'conflict-backed-up'].includes(String(value.syncPhase))
  ) throw new Error('Invalid owner sync metadata');
  return {
    version: 1,
    ownerId,
    cursor: value.cursor,
    lastSyncedAt: value.lastSyncedAt,
    migrationComplete: true,
    syncPhase: value.syncPhase as DurableSyncState['syncPhase'],
    rows: parseCloudRows(value.rows),
  };
}

async function assertSelectedUser(ownerStorage: OwnerStorage, ownerId: string) {
  const owner = await ownerStorage.getOwner();
  if (owner.kind !== 'user' || owner.id !== ownerId) {
    throw new Error(`The active owner does not match ${ownerId}`);
  }
}

function parseCompletion(value: unknown, ownerId: string): MigrationCompletion {
  if (!isRecord(value) || value.migrationComplete !== true) {
    throw new Error('Invalid commit journal completion');
  }
  const rows = parseCloudRows(value.rows);
  if (rows.some((row) => row.ownerId !== ownerId)) throw new Error('Commit journal owner mismatch');
  const conflicts = parseCloudRows(value.conflictBackups);
  if (conflicts.some((row) => row.ownerId !== ownerId)) throw new Error('Conflict backup owner mismatch');
  if (
    typeof value.cursor !== 'string'
    || !['synced', 'conflict-backed-up'].includes(String(value.syncPhase))
  ) throw new Error('Invalid commit journal metadata');
  return {
    rows,
    conflictBackups: conflicts,
    cursor: value.cursor,
    migrationComplete: true,
    syncPhase: value.syncPhase as MigrationCompletion['syncPhase'],
  };
}

function parsePersonalSnapshot(
  value: unknown,
  ownerId: string,
  updatedAt: string,
): PersonalSnapshot {
  if (
    !isRecord(value)
    || !isRecord(value.entries)
    || !Array.isArray(value.specialDates)
    || !isRecord(value.preferences)
    || !Array.isArray(value.stamps)
    || !Array.isArray(value.trips)
    || !Array.isArray(value.tripItems)
  ) {
    const fields = isRecord(value) ? Object.keys(value).sort().join(',') : typeof value;
    throw new Error(`Invalid account commit journal snapshot shape (${fields})`);
  }

  const rows = snapshotToCloudRows(
    { kind: 'user', id: ownerId },
    clone(value) as unknown as PersonalSnapshot,
    [],
    updatedAt,
  ).map((seed): CloudRow => {
    const parsed = parseCloudRowSeed(seed);
    return {
      ownerId,
      entity: parsed.entity ?? 'calendar-entry',
      id: parsed.id,
      revision: parsed.revision,
      payload: parsed.payload,
      updatedAt: parsed.updatedAt ?? updatedAt,
      schemaVersion: parsed.schemaVersion ?? CURRENT_PERSONAL_SCHEMA_VERSION,
      ...(parsed.deletedAt ? { deletedAt: parsed.deletedAt } : {}),
    };
  });
  return snapshotFromCloudRows(rows);
}

function snapshotRows(
  snapshot: PersonalSnapshot,
  ownerId: string,
  updatedAt: string,
): CloudRow[] {
  return snapshotToCloudRows(
    { kind: 'user', id: ownerId },
    snapshot,
    [],
    updatedAt,
  ).map((row) => ({
    ownerId,
    entity: row.entity ?? 'calendar-entry',
    id: row.id,
    revision: row.revision,
    payload: clone(row.payload),
    updatedAt: row.updatedAt ?? updatedAt,
    schemaVersion: row.schemaVersion ?? CURRENT_PERSONAL_SCHEMA_VERSION,
  }));
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined).sort();
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key])
    ));
}

function mergeNewerLocalSnapshot(
  intended: PersonalSnapshot,
  beforeCommit: PersonalSnapshot,
  latestLocal: PersonalSnapshot,
  ownerId: string,
  updatedAt: string,
): PersonalSnapshot {
  const beforeByKey = new Map(
    snapshotRows(beforeCommit, ownerId, updatedAt)
      .map((row) => [rowKey(row.entity, row.id), row]),
  );
  const latestByKey = new Map(
    snapshotRows(latestLocal, ownerId, updatedAt)
      .map((row) => [rowKey(row.entity, row.id), row]),
  );
  const changedKeys = new Set(
    [...new Set([...beforeByKey.keys(), ...latestByKey.keys()])].filter((key) => {
      const before = beforeByKey.get(key);
      const latest = latestByKey.get(key);
      return !before || !latest || !jsonValuesEqual(before.payload, latest.payload);
    }),
  );
  const mergedRows = snapshotRows(intended, ownerId, updatedAt)
    .filter((row) => !changedKeys.has(rowKey(row.entity, row.id)));
  for (const [key, row] of latestByKey) {
    if (changedKeys.has(key)) mergedRows.push(row);
  }
  return snapshotFromCloudRows(mergedRows);
}

function parseJournal(value: unknown, ownerId: string): CommitJournal | null {
  if (value === null) return null;
  if (!isRecord(value) || value.version !== 1 || value.ownerId !== ownerId || !isRecord(value.snapshot)) {
    throw new Error('Invalid account commit journal');
  }
  const completion = parseCompletion(value.completion, ownerId);
  const committedAt = requireNonEmptyString(value.committedAt, 'commit timestamp');
  return {
    version: 1,
    ownerId,
    snapshot: parsePersonalSnapshot(value.snapshot, ownerId, committedAt),
    completion,
    committedAt,
  };
}

export function createAccountBootstrapPersistence(
  options: PersistenceOptions,
): AccountBootstrapPersistence & AccountRuntimeSyncPersistence {
  const now = options.now ?? (() => new Date());
  const stateStorage = createOwnerStateStorage(options.ownerStorage, {});
  const readRuntimeSnapshot = () => (
    options.local.readRuntimeSnapshot?.() ?? options.local.readSnapshot()
  );

  const writeBinding = (binding: {
    activeAccountId: string | null;
    pendingTransition: { targetUserId: string; hasSourceRows: boolean } | null;
  }) =>
    options.storage.setItem(ACCOUNT_BOOTSTRAP_BINDING_KEY, JSON.stringify(binding));

  const readSyncState = async (ownerId: string) => {
    await assertSelectedUser(options.ownerStorage, ownerId);
    return parseSyncState(await readJson(stateStorage, ACCOUNT_SYNC_STATE_DOMAIN), ownerId);
  };

  const writeCompletion = async (
    ownerId: string,
    completion: MigrationCompletion,
    committedAt: string,
    targetStorage: StateStorage = stateStorage,
  ) => {
    const syncState: DurableSyncState = {
      version: 1,
      ownerId,
      cursor: completion.cursor,
      lastSyncedAt: committedAt,
      migrationComplete: true,
      syncPhase: completion.syncPhase,
      rows: clone(completion.rows),
    };
    await targetStorage.setItem(ACCOUNT_SYNC_STATE_DOMAIN, JSON.stringify(syncState));

    const currentConflictsValue = await readJson(targetStorage, ACCOUNT_CONFLICT_BACKUP_DOMAIN);
    const currentConflicts = currentConflictsValue === null ? [] : parseCloudRows(currentConflictsValue);
    await targetStorage.setItem(
      ACCOUNT_CONFLICT_BACKUP_DOMAIN,
      JSON.stringify([...currentConflicts, ...clone(completion.conflictBackups)]),
    );
  };

  const preserveLatestLocal = async (
    journal: CommitJournal,
    completionAlreadyWritten: boolean,
    localBeforeCommit: PersonalSnapshot,
    guard: AccountRuntimePublishGuard,
    targetStorage: StateStorage,
    persistSnapshot: (snapshot: PersonalSnapshot) => Promise<void>,
  ) => {
    let latestLocal = parsePersonalSnapshot(
      readRuntimeSnapshot(),
      journal.ownerId,
      journal.committedAt,
    );
    let localJournal: CommitJournal;
    let completionWritten = completionAlreadyWritten;
    while (true) {
      localJournal = {
        ...journal,
        snapshot: mergeNewerLocalSnapshot(
          journal.snapshot,
          localBeforeCommit,
          latestLocal,
          journal.ownerId,
          journal.committedAt,
        ),
      };
      // Replace the recovery journal before rewriting the owner cache. A process
      // death can therefore only replay the rebased local snapshot, never the pull.
      await targetStorage.setItem(ACCOUNT_COMMIT_JOURNAL_DOMAIN, JSON.stringify(localJournal));
      if (!guard.isCurrent()) return false;
      await persistSnapshot(clone(localJournal.snapshot));
      if (!guard.isCurrent()) return false;
      if (!completionWritten) {
        await writeCompletion(
          journal.ownerId,
          journal.completion,
          journal.committedAt,
          targetStorage,
        );
        completionWritten = true;
      }
      if (!guard.isCurrent()) return false;
      const afterWrites = parsePersonalSnapshot(
        readRuntimeSnapshot(),
        journal.ownerId,
        journal.committedAt,
      );
      if (jsonValuesEqual(afterWrites, latestLocal)) break;
      latestLocal = afterWrites;
    }
    guard.runWhilePublishing(() => options.local.replaceSnapshot(clone(localJournal.snapshot)));
    await targetStorage.removeItem(ACCOUNT_COMMIT_JOURNAL_DOMAIN);
    return false;
  };

  const applyJournal = async (
    journal: CommitJournal,
    guard?: AccountRuntimePublishGuard,
    localBeforeCommit?: PersonalSnapshot,
    targetStorage: StateStorage = stateStorage,
    persistSnapshot: (snapshot: PersonalSnapshot) => Promise<void> = options.local.persistSnapshot,
  ): Promise<boolean> => {
    if (guard && !guard.isCurrent()) return false;
    if (guard && localBeforeCommit && !guard.canPublish()) {
      return preserveLatestLocal(
        journal,
        false,
        localBeforeCommit,
        guard,
        targetStorage,
        persistSnapshot,
      );
    }
    await persistSnapshot(clone(journal.snapshot));
    if (guard && !guard.isCurrent()) return false;
    if (guard && localBeforeCommit && !guard.canPublish()) {
      return preserveLatestLocal(
        journal,
        false,
        localBeforeCommit,
        guard,
        targetStorage,
        persistSnapshot,
      );
    }
    await writeCompletion(
      journal.ownerId,
      journal.completion,
      journal.committedAt,
      targetStorage,
    );
    if (guard && !guard.isCurrent()) return false;
    if (guard && localBeforeCommit && !guard.canPublish()) {
      return preserveLatestLocal(
        journal,
        true,
        localBeforeCommit,
        guard,
        targetStorage,
        persistSnapshot,
      );
    }
    if (guard) {
      guard.runWhilePublishing(() => options.local.replaceSnapshot(clone(journal.snapshot)));
    } else {
      options.local.replaceSnapshot(clone(journal.snapshot));
    }
    await targetStorage.removeItem(ACCOUNT_COMMIT_JOURNAL_DOMAIN);
    return guard ? guard.isCurrent() && guard.canPublish() : true;
  };

  return {
    readBinding: () => readBinding(options.storage),

    async beginTransition(transition) {
      requireNonEmptyString(transition.targetUserId, 'transition target');
      const binding = await readBinding(options.storage);
      const priorTargets = new Set([
        binding.pendingTransition?.targetUserId ?? null,
        binding.activeAccountId,
      ].filter((value): value is string => value !== null));
      if (transition.sourceRows !== null) {
        const transitionSnapshot = clone(readRuntimeSnapshot());
        const sourceRows = transition.sourceRows.map(parseCloudRowSeed);
        await options.storage.setItem(
          transitionSourceKey(transition.targetUserId),
          JSON.stringify(sourceRows),
        );
        const transitionMedia = extractTransitionMedia(
          transitionSnapshot,
          transition.targetUserId,
        );
        const serializedMedia = JSON.stringify(transitionMedia);
        await options.storage.setItem(
          transitionMediaKey(transition.targetUserId),
          serializedMedia,
        );
        const verifiedMedia = await readTransitionMedia(
          options.storage,
          transition.targetUserId,
        );
        if (JSON.stringify(verifiedMedia) !== serializedMedia) {
          throw new Error('Pending transition media could not be verified');
        }
        await options.stageTransitionMedia?.(
          transition.targetUserId,
          transitionSnapshot,
        );
      }
      await writeBinding({
        activeAccountId: binding.activeAccountId,
        pendingTransition: {
          targetUserId: transition.targetUserId,
          hasSourceRows: transition.sourceRows !== null,
        },
      });
      if (transition.sourceRows === null) {
        await options.storage.removeItem(transitionSourceKey(transition.targetUserId));
        await options.storage.removeItem(transitionMediaKey(transition.targetUserId));
      }
      for (const priorTarget of priorTargets) {
        if (priorTarget === transition.targetUserId) continue;
        await options.storage.removeItem(transitionSourceKey(priorTarget));
        await options.storage.removeItem(transitionMediaKey(priorTarget));
      }
    },

    async completeTransition(userId) {
      requireNonEmptyString(userId, 'completed account');
      const binding = await readBinding(options.storage);
      if (binding.pendingTransition && binding.pendingTransition.targetUserId !== userId) {
        throw new Error('Completed account does not match pending transition');
      }
      await writeBinding({ activeAccountId: userId, pendingTransition: null });
      await options.storage.removeItem(transitionSourceKey(userId));
      // The media worker clears the private handoff only after all device sources
      // have their own durable staged upload jobs. The account migration finishing
      // alone is not a safe boundary for cache-backed picker URIs.
    },

    async clearAccountBinding() {
      let pendingTarget: string | null = null;
      let activeTarget: string | null = null;
      try {
        const binding = await readBinding(options.storage);
        pendingTarget = binding.pendingTransition?.targetUserId ?? null;
        activeTarget = binding.activeAccountId;
      } catch {
        // Signing out must be able to recover a corrupt transition pointer.
      }
      await writeBinding({ activeAccountId: null, pendingTransition: null });
      for (const target of new Set([pendingTarget, activeTarget].filter(
        (value): value is string => value !== null,
      ))) {
        await options.storage.removeItem(transitionSourceKey(target));
        await options.storage.removeItem(transitionMediaKey(target));
      }
    },

    async recoverOwner(ownerId) {
      await assertSelectedUser(options.ownerStorage, ownerId);
      const journal = parseJournal(
        await readJson(stateStorage, ACCOUNT_COMMIT_JOURNAL_DOMAIN),
        ownerId,
      );
      if (journal) await applyJournal(journal);
    },

    async readLocalRows(owner) {
      const selected = await options.ownerStorage.getOwner();
      if (selected.kind !== owner.kind || selected.id !== owner.id) {
        throw new Error('Cannot read a cache that is not the active owner');
      }
      const priorRows = owner.kind === 'user'
        ? (await readSyncState(owner.id))?.rows ?? []
        : [];
      return snapshotToCloudRows(
        owner,
        createPortableSnapshot(
          options.local.readSnapshot() as unknown as PersonalSnapshotInput,
          owner.id,
        ),
        priorRows,
        now().toISOString(),
      );
    },

    async stageSourceRows(ownerId, rows) {
      await assertSelectedUser(options.ownerStorage, ownerId);
      const normalized: CloudRow[] = rows.map((seed) => {
        const parsed = parseCloudRowSeed(seed);
        return {
          ownerId,
          entity: parsed.entity ?? 'calendar-entry',
          id: parsed.id,
          revision: parsed.revision,
          payload: parsed.payload,
          updatedAt: parsed.updatedAt ?? now().toISOString(),
          schemaVersion: parsed.schemaVersion ?? CURRENT_PERSONAL_SCHEMA_VERSION,
          ...(parsed.deletedAt ? { deletedAt: parsed.deletedAt } : {}),
        };
      });
      const transitionMedia = await readTransitionMedia(options.storage, ownerId);
      const stagedSnapshot = transitionMedia
        ? overlayTransitionMedia(snapshotFromCloudRows(normalized), transitionMedia)
        : snapshotFromCloudRows(normalized);
      await options.local.persistSnapshot(stagedSnapshot);
      options.local.replaceSnapshot(clone(stagedSnapshot));
    },

    async persistLocalBackup(ownerId, rows) {
      await assertSelectedUser(options.ownerStorage, ownerId);
      if (rows.some((row) => row.ownerId !== ownerId)) throw new Error('Local backup owner mismatch');
      await stateStorage.setItem(ACCOUNT_LOCAL_BACKUP_DOMAIN, JSON.stringify(clone(rows)));
    },

    async commitMigration(ownerId, completion) {
      await assertSelectedUser(options.ownerStorage, ownerId);
      if (
        completion.rows.some((row) => row.ownerId !== ownerId)
        || completion.conflictBackups.some((row) => row.ownerId !== ownerId)
      ) throw new Error('Migration completion owner mismatch');
      const committedAt = now().toISOString();
      const remoteSnapshot = snapshotFromCloudRows(completion.rows);
      const runtimeMedia = extractTransitionMedia(readRuntimeSnapshot(), ownerId);
      const journal: CommitJournal = {
        version: 1,
        ownerId,
        snapshot: overlayTransitionMedia(remoteSnapshot, runtimeMedia),
        completion: clone(completion),
        committedAt,
      };
      await stateStorage.setItem(ACCOUNT_COMMIT_JOURNAL_DOMAIN, JSON.stringify(journal));
      await applyJournal(journal);
    },

    async commitRuntimeSync(ownerId, completion, snapshot, guard) {
      await assertSelectedUser(options.ownerStorage, ownerId);
      if (
        completion.rows.some((row) => row.ownerId !== ownerId)
        || completion.conflictBackups.some((row) => row.ownerId !== ownerId)
      ) throw new Error('Runtime sync completion owner mismatch');
      const committedAt = now().toISOString();
      const localBeforeCommit = parsePersonalSnapshot(
        readRuntimeSnapshot(),
        ownerId,
        committedAt,
      );
      const journal: CommitJournal = {
        version: 1,
        ownerId,
        snapshot: parsePersonalSnapshot(snapshot, ownerId, committedAt),
        completion: clone(completion),
        committedAt,
      };
      const runtimeStorage = createExplicitUserStateStorage(options.storage, ownerId);
      const persistRuntimeSnapshot = (nextSnapshot: PersonalSnapshot) => (
        options.local.persistRuntimeSnapshot?.(ownerId, nextSnapshot)
        ?? options.local.persistSnapshot(nextSnapshot)
      );
      await runtimeStorage.setItem(ACCOUNT_COMMIT_JOURNAL_DOMAIN, JSON.stringify(journal));
      return applyJournal(
        journal,
        guard,
        localBeforeCommit,
        runtimeStorage,
        persistRuntimeSnapshot,
      );
    },
  };
}

function parseOutbox(value: unknown, ownerId: string): OutboxMutation[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error('Invalid account outbox');
  return value.map((item) => {
    if (!isRecord(item)) throw new Error('Invalid account outbox mutation');
    if (item.ownerId !== ownerId) throw new Error('Outbox owner mismatch');
    if (!CLOUD_ENTITIES.has(item.entity as CloudEntity)) throw new Error('Invalid outbox entity');
    requireNonEmptyString(item.mutationId, 'outbox mutation id');
    requireNonEmptyString(item.entityId, 'outbox entity id');
    if (item.operation !== 'upsert' && item.operation !== 'delete') throw new Error('Invalid outbox operation');
    if (!Number.isInteger(item.attempts) || Number(item.attempts) < 0) throw new Error('Invalid outbox attempts');
    if (item.baseRevision !== null && (!Number.isInteger(item.baseRevision) || Number(item.baseRevision) < 1)) {
      throw new Error('Invalid outbox base revision');
    }
    if (item.payload !== null && !isRecord(item.payload)) throw new Error('Invalid outbox payload');
    requireNonEmptyString(item.createdAt, 'outbox timestamp');
    const schemaVersion = requireCurrentPersonalSchemaVersion(
      item.schemaVersion ?? item.schema_version,
      `Outbox mutation ${String(item.mutationId)}`,
    );
    return { ...clone(item), schemaVersion } as unknown as OutboxMutation;
  });
}

function parseConflictBackups(value: unknown, ownerId: string): OutboxConflictBackup[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error('Invalid conflict backup list');
  return value.map((item) => {
    if (!isRecord(item) || !isRecord(item.mutation) || item.mutation.ownerId !== ownerId) {
      throw new Error('Invalid conflict backup');
    }
    return clone(item) as unknown as OutboxConflictBackup;
  });
}

export function createAccountBootstrapOutbox({
  ownerStorage,
  now = () => new Date(),
}: {
  ownerStorage: OwnerStorage;
  now?: () => Date;
}): AccountBootstrapOutbox {
  const stateStorage = createOwnerStateStorage(ownerStorage, {});
  return {
    async flush(ownerId: string, repository: CloudRepository) {
      await assertSelectedUser(ownerStorage, ownerId);
      const mutations = parseOutbox(await readJson(stateStorage, ACCOUNT_OUTBOX_DOMAIN), ownerId);
      const syncState = parseSyncState(
        await readJson(stateStorage, ACCOUNT_SYNC_STATE_DOMAIN),
        ownerId,
      );
      const result = await flushOutbox(mutations, repository, {
        ownerId,
        lastSyncedAt: syncState?.lastSyncedAt ?? null,
        now: now(),
        commitOutbox: async (pending) => {
          await stateStorage.setItem(ACCOUNT_OUTBOX_DOMAIN, JSON.stringify(clone(pending)));
        },
        persistConflictBackups: async (conflicts) => {
          const existing = parseConflictBackups(
            await readJson(stateStorage, ACCOUNT_OUTBOX_CONFLICT_BACKUP_DOMAIN),
            ownerId,
          );
          await stateStorage.setItem(
            ACCOUNT_OUTBOX_CONFLICT_BACKUP_DOMAIN,
            JSON.stringify([...existing, ...clone(conflicts)]),
          );
        },
      });
      return { syncPhase: result.syncPhase };
    },
  };
}

function createZustandLocalBridge(
  storage: KeyValueStorage,
  ownerStorage: OwnerStorage,
): AccountBootstrapLocalBridge {
  const stateStorage = createOwnerStateStorage(ownerStorage, {});
  const readSnapshotInput = () => {
    const calendar = useCalendarStore.getState();
    const stamps = useStampStore.getState();
    const trips = useTripStore.getState();
    return {
      calendar,
      stamps,
      input: {
        entries: calendar.entries,
        specialDates: calendar.specialDates,
        preferences: {
          weekStartDay: calendar.weekStartDay,
          recurringSchedules: calendar.recurringSchedules,
          locale: useLocaleStore.getState().locale,
        },
        stamps: stamps.stamps,
        trips: trips.trips,
        tripItems: trips.items,
      },
    };
  };
  const persistSnapshotTo = async (
    snapshot: PersonalSnapshot,
    targetStorage: StateStorage,
  ) => {
    const calendarState = {
      entries: snapshot.entries,
      recurringSchedules: snapshot.preferences.recurringSchedules ?? [],
      specialDates: snapshot.specialDates,
      weekStartDay: snapshot.preferences.weekStartDay ?? 1,
    };
    const stampState = { stamps: snapshot.stamps };
    const tripState = { trips: snapshot.trips, items: snapshot.tripItems };
    await Promise.all([
      targetStorage.setItem('calendar', JSON.stringify({ state: calendarState, version: 0 })),
      targetStorage.setItem('stamps', JSON.stringify({ state: stampState, version: 0 })),
      targetStorage.setItem('trips', JSON.stringify({ state: tripState, version: 0 })),
      ...(snapshot.preferences.locale
        ? [storage.setItem(
            'app-locale',
            JSON.stringify({ state: { locale: snapshot.preferences.locale }, version: 0 }),
          )]
        : []),
    ]);
  };
  return {
    readSnapshot() {
      return createPortableSnapshot(readSnapshotInput().input);
    },

    readRuntimeSnapshot() {
      const { calendar, stamps, input } = readSnapshotInput();
      const snapshot = createPortableSnapshot(input);
      for (const [id, entry] of Object.entries(calendar.entries)) {
        const portable = snapshot.entries[id];
        if (!portable) continue;
        if (typeof entry.imageUri === 'string') portable.imageUri = entry.imageUri;
        if (entry.diaryPhotos) portable.diaryPhotos = [...entry.diaryPhotos];
      }
      snapshot.stamps.forEach((portable, index) => {
        const imageUri = stamps.stamps[index]?.imageUri;
        if (typeof imageUri === 'string') portable.imageUri = imageUri;
      });
      return snapshot;
    },

    persistSnapshot: (snapshot) => persistSnapshotTo(snapshot, stateStorage),

    persistRuntimeSnapshot: (ownerId, snapshot) => persistSnapshotTo(
      snapshot,
      createExplicitUserStateStorage(storage, ownerId),
    ),

    replaceSnapshot(snapshot) {
      useCalendarStore.getState().replaceState({
        entries: clone(snapshot.entries) as Record<string, DayEntry>,
        recurringSchedules: clone(snapshot.preferences.recurringSchedules ?? []) as RecurringSchedule[],
        specialDates: clone(snapshot.specialDates) as SpecialDate[],
        weekStartDay: snapshot.preferences.weekStartDay ?? 1,
      });
      useStampStore.getState().replaceState({
        stamps: clone(snapshot.stamps) as Stamp[],
      });
      useTripStore.getState().replaceFromCloud(
        clone(snapshot.trips) as unknown as Trip[],
        clone(snapshot.tripItems) as unknown as TripItem[],
      );
      if (snapshot.preferences.locale) {
        useLocaleStore.getState().setLocale(snapshot.preferences.locale);
      }
    },
  };
}

export function createProductionAccountBootstrapRuntime() {
  const ownerStorage = getPersonalOwnerStorage(AsyncStorage);
  const local = createZustandLocalBridge(AsyncStorage, ownerStorage);
  const transitionMediaStager = createProductionPersonalMediaTransitionStager({
    storage: AsyncStorage,
  });
  return {
    ownerStorage,
    persistence: createAccountBootstrapPersistence({
      storage: AsyncStorage,
      ownerStorage,
      local,
      stageTransitionMedia: (ownerId, snapshot) =>
        transitionMediaStager.stage(ownerId, snapshot),
    }),
    outbox: createAccountBootstrapOutbox({ ownerStorage }),
    owners: {
      getCurrentOwner: () => ownerStorage.getOwner(),
      getInstallationGuestOwner: async (): Promise<DataOwner> => {
        const installationId = await AsyncStorage.getItem('recoto:installation-id');
        if (!installationId) {
          const initialized = await ownerStorage.getOwner();
          if (initialized.kind === 'guest') return initialized;
          throw new Error('Installation guest owner is unavailable');
        }
        return { kind: 'guest', id: installationId };
      },
      switchOwnerAndRehydrate: (owner: DataOwner) =>
        switchOwnerAndRehydrate({
          ownerStorage,
          owner,
          targets: [
            createCalendarOwnerSwitchTarget(),
            createStampOwnerSwitchTarget(),
            createTripOwnerSwitchTarget(),
          ],
        }),
    },
  };
}
