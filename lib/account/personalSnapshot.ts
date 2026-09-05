import type {
  DayEntry,
  NoteItem,
  RecurringSchedule,
  SpecialDate,
  Stamp,
  TimeSlot,
} from '../../types';
import type {
  PersonalSnapshot,
  PortableCalendarEntry,
  PortableNoteItem,
  PortablePreferences,
  PortableRecurringSchedule,
  PortableSpecialDate,
  PortableStamp,
  PortableTimeSlot,
  PortableTrip,
  PortableTripItem,
} from '../../types/account';
import type { Trip, TripItem } from '../../types/travel';
import {
  assertActiveTripGraph,
  tripItemToCloudPayload,
  tripToCloudPayload,
} from './tripMapper';

export interface PersonalSnapshotInput {
  entries: Record<string, DayEntry>;
  specialDates: SpecialDate[];
  preferences: Record<string, unknown>;
  stamps: Stamp[];
  trips: unknown[];
  tripItems: unknown[];
}

const isDeviceUri = (value: string) =>
  value.startsWith('file://') || value.startsWith('content://');

const portableString = (value: unknown) =>
  typeof value === 'string' && !isDeviceUri(value) ? value : undefined;

const PERSONAL_MEDIA_OBJECT_KEY =
  /^([A-Za-z0-9_-]+)\/(calendar|diary|stamp|trip)\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\.jpg$/;

// Signed URLs expire and can contain bearer-like query parameters. Only stable
// object keys (plus built-in icon references) belong in portable payloads.
const portableMediaString = (
  value: unknown,
  expectedDomain: 'calendar' | 'diary' | 'stamp' | 'trip'
    | readonly ('calendar' | 'diary' | 'stamp' | 'trip')[],
  expectedOwnerId?: string,
) => {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('icon://')) return value;
  const match = PERSONAL_MEDIA_OBJECT_KEY.exec(value);
  const allowedDomains = typeof expectedDomain === 'string'
    ? [expectedDomain]
    : expectedDomain;
  if (!match || !allowedDomains.includes(
    match[2].toLowerCase() as 'calendar' | 'diary' | 'stamp' | 'trip',
  )) return undefined;
  if (expectedOwnerId !== undefined && match[1] !== expectedOwnerId) return undefined;
  return value;
};

const addOptional = <T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V | undefined,
): T & Partial<Record<K, V>> => {
  if (value !== undefined) Object.assign(target, { [key]: value });
  return target;
};

function createPortableNoteItem(item: NoteItem): PortableNoteItem {
  const result: PortableNoteItem = { id: item.id, text: item.text };
  addOptional(result, 'time', item.time);
  addOptional(result, 'endTime', item.endTime);
  addOptional(result, 'notificationEnabled', item.notificationEnabled);
  addOptional(result, 'fromTimeSlotId', item.fromTimeSlotId);
  addOptional(result, 'color', item.color);
  addOptional(result, 'url', portableString(item.url));
  addOptional(result, 'fromGoogleId', item.fromGoogleId);
  addOptional(result, 'syncToGoogle', item.syncToGoogle);
  addOptional(result, 'googleSyncDirection', item.googleSyncDirection);
  return result;
}

function createPortableTimeSlot(slot: TimeSlot): PortableTimeSlot {
  const result: PortableTimeSlot = {
    id: slot.id,
    startTime: slot.startTime,
    endTime: slot.endTime,
    title: slot.title,
    color: slot.color,
  };
  addOptional(result, 'url', portableString(slot.url));
  addOptional(result, 'notificationEnabled', slot.notificationEnabled);
  addOptional(result, 'reflectToMonthly', slot.reflectToMonthly);
  return result;
}

export function createPortableCalendarEntry(
  entry: DayEntry,
  expectedOwnerId?: string,
): PortableCalendarEntry {
  const result: PortableCalendarEntry = {
    date: entry.date,
    miniStamps: {
      ...(entry.miniStamps.left ? { left: entry.miniStamps.left } : {}),
      ...(entry.miniStamps.right ? { right: entry.miniStamps.right } : {}),
    },
    privacyLevel: entry.privacyLevel,
  };

  addOptional(result, 'mainStampId', entry.mainStampId);
  addOptional(result, 'notes', entry.notes);
  addOptional(result, 'noteItems', entry.noteItems?.map(createPortableNoteItem));
  addOptional(result, 'startTime', entry.startTime);
  addOptional(result, 'endTime', entry.endTime);
  addOptional(result, 'notificationEnabled', entry.notificationEnabled);
  addOptional(result, 'imageUri', portableMediaString(
    entry.imageUri,
    ['calendar', 'stamp'],
    expectedOwnerId,
  ));
  addOptional(result, 'timeSlots', entry.timeSlots?.map(createPortableTimeSlot));
  addOptional(result, 'diary', entry.diary);
  addOptional(
    result,
    'diaryPhotos',
    entry.diaryPhotos
      ?.map((uri) => portableMediaString(uri, 'diary', expectedOwnerId))
      .filter((uri): uri is string => uri !== undefined),
  );
  addOptional(result, 'diaryConfirmed', entry.diaryConfirmed);
  addOptional(result, 'dailyGoal', entry.dailyGoal);
  return result;
}

function createPortableSpecialDate(date: SpecialDate): PortableSpecialDate {
  const result: PortableSpecialDate = {
    id: date.id,
    name: date.name,
    month: date.month,
    day: date.day,
    color: date.color,
    type: date.type,
  };
  addOptional(result, 'emoji', date.emoji);
  return result;
}

function createPortableStamp(stamp: Stamp, expectedOwnerId?: string): PortableStamp {
  const result: PortableStamp = {
    id: stamp.id,
    text: stamp.text,
    bgColor: stamp.bgColor,
    textColor: stamp.textColor,
  };
  addOptional(result, 'isDefault', stamp.isDefault);
  addOptional(result, 'isMain', stamp.isMain);
  addOptional(result, 'isEnabled', stamp.isEnabled);
  addOptional(result, 'isImageStamp', stamp.isImageStamp);
  addOptional(result, 'imageUri', portableMediaString(
    stamp.imageUri,
    'stamp',
    expectedOwnerId,
  ));
  return result;
}

function createPortableRecurringSchedule(schedule: RecurringSchedule): PortableRecurringSchedule {
  const result: PortableRecurringSchedule = {
    id: schedule.id,
    name: schedule.name,
    stampId: schedule.stampId,
    stampPosition: schedule.stampPosition,
    daysOfWeek: [...schedule.daysOfWeek],
  };
  addOptional(result, 'appliedMonths', schedule.appliedMonths ? [...schedule.appliedMonths] : undefined);
  return result;
}

function createPortablePreferences(input: Record<string, unknown>): PortablePreferences {
  const result: PortablePreferences = {};
  if (input.weekStartDay === 0 || input.weekStartDay === 1) {
    result.weekStartDay = input.weekStartDay;
  }
  if (input.locale === 'ja' || input.locale === 'en') result.locale = input.locale;
  if (Array.isArray(input.recurringSchedules)) {
    result.recurringSchedules = (input.recurringSchedules as RecurringSchedule[])
      .map(createPortableRecurringSchedule);
  }
  return result;
}

export class PersonalSnapshotQuarantineError extends Error {
  readonly code = 'travel-snapshot-quarantined';
  readonly retryable = false;

  constructor(message: string, options?: ErrorOptions) {
    super(`Travel snapshot quarantined: ${message}`, options);
    this.name = 'PersonalSnapshotQuarantineError';
  }
}

function portableTravel(
  tripsInput: readonly unknown[],
  itemsInput: readonly unknown[],
): { trips: PortableTrip[]; tripItems: PortableTripItem[] } {
  try {
    const trips = tripsInput.map((value) => tripToCloudPayload(value as Trip));
    const tripItems = itemsInput.map((value) => tripItemToCloudPayload(value as TripItem));
    assertActiveTripGraph(trips as Trip[], tripItems as TripItem[]);
    return { trips, tripItems };
  } catch (error) {
    throw new PersonalSnapshotQuarantineError(
      error instanceof Error ? error.message : 'invalid travel data',
      { cause: error },
    );
  }
}

export function createPortableSnapshot(
  snapshot: PersonalSnapshotInput,
  expectedOwnerId?: string,
): PersonalSnapshot {
  const travel = portableTravel(snapshot.trips, snapshot.tripItems);
  return {
    entries: Object.fromEntries(
      Object.entries(snapshot.entries).map(([date, entry]) => [
        date,
        createPortableCalendarEntry(entry, expectedOwnerId),
      ]),
    ),
    specialDates: snapshot.specialDates.map(createPortableSpecialDate),
    preferences: createPortablePreferences(snapshot.preferences),
    stamps: snapshot.stamps.map((stamp) => createPortableStamp(stamp, expectedOwnerId)),
    trips: travel.trips,
    tripItems: travel.tripItems,
  };
}
