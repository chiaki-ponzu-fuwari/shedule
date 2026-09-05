import { TRIP_ITEM_TYPES, TRIP_TRANSPORT_ICONS } from '../../constants/travel';
import type { PortableTrip, PortableTripItem } from '../../types/account';
import type { Trip, TripItem, TripItemType, TripTransportIcon } from '../../types/travel';
import { normalizeSafeUrl } from '../../utils/safeUrl';
import { isValidLocalDate, validateTripDraft } from '../../utils/tripUtils';
import { normalizeIanaTimeZone } from '../../utils/tripTimezone';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function normalizeUtcInstant(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  const canonicalInput = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const normalized = parsed.toISOString();
  return normalized === canonicalInput ? normalized : null;
}

function normalizeTimezone(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? normalizeIanaTimeZone(value) : null;
}

export function tripToCloudPayload(trip: Trip): PortableTrip {
  const result: PortableTrip = {
    id: trip.id,
    title: trip.title,
    startDate: trip.startDate,
    endDate: trip.endDate,
    color: trip.color,
    startIcon: trip.startIcon,
    endIcon: trip.endIcon,
    createdAt: trip.createdAt,
    updatedAt: trip.updatedAt,
    revision: trip.revision,
  };
  if (trip.memo !== undefined) result.memo = trip.memo;
  if (trip.deletedAt !== undefined) result.deletedAt = trip.deletedAt;
  return tripFromCloudPayload(trip.id, result);
}

export function tripFromCloudPayload(id: string, value: unknown): Trip {
  if (!isRecord(value)) throw new Error(`Invalid trip ${id}`);
  const candidate = {
    id,
    title: value.title,
    startDate: value.startDate,
    endDate: value.endDate,
    color: value.color,
    startIcon: value.startIcon,
    endIcon: value.endIcon,
    memo: value.memo,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    revision: value.revision,
    deletedAt: value.deletedAt,
  };
  const createdAt = normalizeUtcInstant(candidate.createdAt);
  const updatedAt = normalizeUtcInstant(candidate.updatedAt);
  const deletedAt = normalizeUtcInstant(candidate.deletedAt);
  if (
    (value.id !== undefined && value.id !== id)
    || typeof candidate.title !== 'string'
    || typeof candidate.startDate !== 'string'
    || typeof candidate.endDate !== 'string'
    || typeof candidate.color !== 'string'
    || typeof candidate.startIcon !== 'string'
    || typeof candidate.endIcon !== 'string'
    || typeof createdAt !== 'string'
    || typeof updatedAt !== 'string'
    || !Number.isSafeInteger(candidate.revision)
    || Number(candidate.revision) < 1
    || !optionalString(candidate.memo)
    || deletedAt === null
    || !TRIP_TRANSPORT_ICONS.includes(candidate.startIcon as TripTransportIcon)
    || !TRIP_TRANSPORT_ICONS.includes(candidate.endIcon as TripTransportIcon)
  ) throw new Error(`Invalid trip ${id}`);

  const trip: Trip = {
    ...(candidate as Trip),
    createdAt,
    updatedAt,
    ...(typeof deletedAt === 'string' ? { deletedAt } : { deletedAt: undefined }),
  };
  if (!validateTripDraft(trip).valid) throw new Error(`Invalid trip ${id}`);
  return trip;
}

export function tripItemToCloudPayload(item: TripItem): PortableTripItem {
  const result: PortableTripItem = {
    id: item.id,
    tripId: item.tripId,
    type: item.type,
    localDate: item.localDate,
    allDay: item.allDay,
    sortOrder: item.sortOrder,
  };
  const keys = [
    'startsAtUtc',
    'endsAtUtc',
    'arrivalLocalDate',
    'departureTimezone',
    'arrivalTimezone',
    'departure',
    'arrival',
    'place',
    'reservationNumber',
    'memo',
  ] as const;
  keys.forEach((key) => {
    if (item[key] !== undefined) result[key] = item[key];
  });
  if (item.url !== undefined) result.url = item.url;
  return tripItemFromCloudPayload(item.id, result);
}

export function tripItemFromCloudPayload(id: string, value: unknown): TripItem {
  if (!isRecord(value)) throw new Error(`Invalid trip item ${id}`);
  const startsAtUtc = normalizeUtcInstant(value.startsAtUtc);
  const endsAtUtc = normalizeUtcInstant(value.endsAtUtc);
  const departureTimezone = normalizeTimezone(value.departureTimezone);
  const arrivalTimezone = normalizeTimezone(value.arrivalTimezone);
  if (
    (value.id !== undefined && value.id !== id)
    || typeof value.tripId !== 'string'
    || !value.tripId
    || typeof value.type !== 'string'
    || !TRIP_ITEM_TYPES.includes(value.type as TripItemType)
    || typeof value.localDate !== 'string'
    || !isValidLocalDate(value.localDate)
    || (value.arrivalLocalDate !== undefined && (
      typeof value.arrivalLocalDate !== 'string'
      || !isValidLocalDate(value.arrivalLocalDate)
    ))
    || typeof value.allDay !== 'boolean'
    || !Number.isSafeInteger(value.sortOrder)
    || startsAtUtc === null
    || endsAtUtc === null
    || departureTimezone === null
    || arrivalTimezone === null
    || (value.url !== undefined && typeof value.url !== 'string')
    || !['departure', 'arrival', 'place', 'reservationNumber', 'memo']
      .every((key) => optionalString(value[key]))
  ) throw new Error(`Invalid trip item ${id}`);

  if (
    startsAtUtc !== undefined
    && endsAtUtc !== undefined
    && Date.parse(endsAtUtc) < Date.parse(startsAtUtc)
  ) throw new Error(`Invalid trip item ${id}`);

  const safeUrl = value.url === undefined ? undefined : normalizeSafeUrl(String(value.url));
  if (safeUrl === null) throw new Error(`Invalid trip item URL ${id}`);

  const result: TripItem = {
    id,
    tripId: value.tripId,
    type: value.type as TripItemType,
    localDate: value.localDate,
    allDay: value.allDay,
    sortOrder: Number(value.sortOrder),
  };
  const stringKeys = [
    'arrivalLocalDate', 'departure', 'arrival', 'place', 'reservationNumber', 'memo',
  ] as const;
  stringKeys.forEach((key) => {
    if (typeof value[key] === 'string') result[key] = value[key] as never;
  });
  if (startsAtUtc !== undefined) result.startsAtUtc = startsAtUtc;
  if (endsAtUtc !== undefined) result.endsAtUtc = endsAtUtc;
  if (departureTimezone !== undefined) result.departureTimezone = departureTimezone;
  if (arrivalTimezone !== undefined) result.arrivalTimezone = arrivalTimezone;
  if (safeUrl !== undefined) result.url = safeUrl;
  return result;
}

export function assertTripItemWithinActiveParent(
  item: Pick<TripItem, 'id' | 'tripId' | 'localDate' | 'arrivalLocalDate'>,
  trips: readonly Trip[],
): void {
  const parent = trips.find((trip) => trip.id === item.tripId && !trip.deletedAt);
  if (!parent) throw new Error(`Trip item ${item.id} has no active parent`);
  if (
    item.localDate < parent.startDate
    || item.localDate > parent.endDate
    || Boolean(item.arrivalLocalDate && (
      item.arrivalLocalDate < parent.startDate
      || item.arrivalLocalDate > parent.endDate
    ))
  ) throw new Error(`Trip item ${item.id} is outside the active trip period`);
}

export function assertActiveTripGraph(trips: readonly Trip[], items: readonly TripItem[]): void {
  items.forEach((item) => assertTripItemWithinActiveParent(item, trips));
}
