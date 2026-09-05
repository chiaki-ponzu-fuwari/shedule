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

export function createPortableCalendarEntry(entry: DayEntry): PortableCalendarEntry {
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
  addOptional(result, 'imageUri', portableString(entry.imageUri));
  addOptional(result, 'timeSlots', entry.timeSlots?.map(createPortableTimeSlot));
  addOptional(result, 'diary', entry.diary);
  addOptional(
    result,
    'diaryPhotos',
    entry.diaryPhotos?.map(portableString).filter((uri): uri is string => uri !== undefined),
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

function createPortableStamp(stamp: Stamp): PortableStamp {
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
  addOptional(result, 'imageUri', portableString(stamp.imageUri));
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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

function createPortableTrip(value: unknown): PortableTrip | null {
  const trip = asRecord(value);
  if (!trip) return null;
  const required = [
    'id', 'title', 'startDate', 'endDate', 'color', 'startIcon', 'endIcon', 'createdAt', 'updatedAt',
  ] as const;
  if (required.some((key) => typeof trip[key] !== 'string') || typeof trip.revision !== 'number') {
    return null;
  }
  const result: PortableTrip = {
    id: trip.id as string,
    title: trip.title as string,
    startDate: trip.startDate as string,
    endDate: trip.endDate as string,
    color: trip.color as string,
    startIcon: trip.startIcon as string,
    endIcon: trip.endIcon as string,
    createdAt: trip.createdAt as string,
    updatedAt: trip.updatedAt as string,
    revision: trip.revision,
  };
  addOptional(result, 'memo', portableString(trip.memo));
  addOptional(result, 'deletedAt', portableString(trip.deletedAt));
  return result;
}

function createPortableTripItem(value: unknown): PortableTripItem | null {
  const item = asRecord(value);
  if (!item) return null;
  const required = ['id', 'tripId', 'type', 'localDate'] as const;
  if (
    required.some((key) => typeof item[key] !== 'string') ||
    typeof item.allDay !== 'boolean' ||
    typeof item.sortOrder !== 'number'
  ) {
    return null;
  }
  const result: PortableTripItem = {
    id: item.id as string,
    tripId: item.tripId as string,
    type: item.type as string,
    localDate: item.localDate as string,
    allDay: item.allDay,
    sortOrder: item.sortOrder,
  };
  const stringKeys = [
    'startsAtUtc', 'endsAtUtc', 'departureTimezone', 'arrivalTimezone', 'departure', 'arrival',
    'place', 'reservationNumber', 'memo',
  ] as const;
  stringKeys.forEach((key) => addOptional(result, key, portableString(item[key])));
  addOptional(result, 'url', portableString(item.url));
  return result;
}

export function createPortableSnapshot(snapshot: PersonalSnapshotInput): PersonalSnapshot {
  return {
    entries: Object.fromEntries(
      Object.entries(snapshot.entries).map(([date, entry]) => [date, createPortableCalendarEntry(entry)]),
    ),
    specialDates: snapshot.specialDates.map(createPortableSpecialDate),
    preferences: createPortablePreferences(snapshot.preferences),
    stamps: snapshot.stamps.map(createPortableStamp),
    trips: snapshot.trips.map(createPortableTrip).filter((trip): trip is PortableTrip => trip !== null),
    tripItems: snapshot.tripItems
      .map(createPortableTripItem)
      .filter((item): item is PortableTripItem => item !== null),
  };
}
