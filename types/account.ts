export type AccountMode =
  | 'guest-local'
  | 'guest-connected'
  | 'account-connected'
  | 'deletion-pending';

export type SyncPhase =
  | 'local-only'
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'reauth-required'
  | 'conflict-backed-up'
  | 'error';

export type CloudEntity =
  | 'calendar-entry'
  | 'special-date'
  | 'preference'
  | 'stamp'
  | 'trip'
  | 'trip-item';

export interface OutboxMutation {
  mutationId: string;
  ownerId: string;
  entity: CloudEntity;
  entityId: string;
  operation: 'upsert' | 'delete';
  payload: Record<string, unknown> | null;
  createdAt: string;
  attempts: number;
}

export interface PortableNoteItem {
  id: string;
  text: string;
  time?: string;
  endTime?: string;
  notificationEnabled?: boolean;
  fromTimeSlotId?: string;
  color?: string;
  url?: string;
  fromGoogleId?: string;
  syncToGoogle?: boolean;
  googleSyncDirection?: 'none' | 'toGoogle' | 'fromGoogle' | 'both';
}

export interface PortableTimeSlot {
  id: string;
  startTime: string;
  endTime: string;
  title: string;
  color: string;
  url?: string;
  notificationEnabled?: boolean;
  reflectToMonthly?: boolean;
}

export interface PortableCalendarEntry {
  date: string;
  mainStampId?: string;
  miniStamps: { left?: string; right?: string };
  notes?: string;
  noteItems?: PortableNoteItem[];
  privacyLevel: 0 | 1 | 2 | 3;
  startTime?: string;
  endTime?: string;
  notificationEnabled?: boolean;
  imageUri?: string;
  timeSlots?: PortableTimeSlot[];
  diary?: string;
  diaryPhotos?: string[];
  diaryConfirmed?: boolean;
  dailyGoal?: string;
}

export interface PortableSpecialDate {
  id: string;
  name: string;
  month: number;
  day: number;
  color: string;
  type: 'birthday' | 'anniversary' | 'other';
  emoji?: string;
}

export interface PortableStamp {
  id: string;
  text: string;
  bgColor: string;
  textColor: string;
  isDefault?: boolean;
  isMain?: boolean;
  isEnabled?: boolean;
  isImageStamp?: boolean;
  imageUri?: string;
}

export interface PortableRecurringSchedule {
  id: string;
  name: string;
  stampId: string;
  stampPosition: 'main' | 'mini-left' | 'mini-right';
  daysOfWeek: number[];
  appliedMonths?: string[];
}

export interface PortablePreferences {
  weekStartDay?: 0 | 1;
  locale?: 'ja' | 'en';
  recurringSchedules?: PortableRecurringSchedule[];
}

export interface PortableTrip {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  color: string;
  startIcon: string;
  endIcon: string;
  memo?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  deletedAt?: string;
}

export interface PortableTripItem {
  id: string;
  tripId: string;
  type: string;
  localDate: string;
  allDay: boolean;
  startsAtUtc?: string;
  endsAtUtc?: string;
  departureTimezone?: string;
  arrivalTimezone?: string;
  departure?: string;
  arrival?: string;
  place?: string;
  reservationNumber?: string;
  url?: string;
  memo?: string;
  sortOrder: number;
}

export interface PersonalSnapshot {
  entries: Record<string, PortableCalendarEntry>;
  specialDates: PortableSpecialDate[];
  preferences: PortablePreferences;
  stamps: PortableStamp[];
  trips: PortableTrip[];
  tripItems: PortableTripItem[];
}
