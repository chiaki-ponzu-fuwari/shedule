import { TRIP_COLOR_PRESETS, TRIP_TRANSPORT_ICONS } from '../constants/travel';
import type {
  Trip,
  TripDraft,
  TripDraftError,
  TripWeekSegment,
} from '../types/travel';

const DAY_MS = 86_400_000;

function dayNumber(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;
  return Math.floor(timestamp / DAY_MS);
}

function dateFromDayNumber(value: number): string {
  return new Date(value * DAY_MS).toISOString().slice(0, 10);
}

export function isValidLocalDate(value: string): boolean {
  return dayNumber(value) !== null;
}

export function validateTripDraft(draft: TripDraft): {
  valid: boolean;
  errors: Partial<Record<keyof TripDraft, TripDraftError>>;
} {
  const errors: Partial<Record<keyof TripDraft, TripDraftError>> = {};
  if (!draft.title.trim()) errors.title = 'required';

  const start = dayNumber(draft.startDate);
  const end = dayNumber(draft.endDate);
  if (start === null) errors.startDate = 'invalid';
  if (end === null) errors.endDate = 'invalid';
  if (start !== null && end !== null && end < start) errors.endDate = 'before-start';
  if (!TRIP_COLOR_PRESETS.includes(draft.color as (typeof TRIP_COLOR_PRESETS)[number])) {
    errors.color = 'unsupported';
  }
  if (!TRIP_TRANSPORT_ICONS.includes(draft.startIcon)) errors.startIcon = 'unsupported';
  if (!TRIP_TRANSPORT_ICONS.includes(draft.endIcon)) errors.endIcon = 'unsupported';

  return { valid: Object.keys(errors).length === 0, errors };
}

function tripBucket(trip: Pick<Trip, 'startDate' | 'endDate'>, today: string): number {
  if (trip.startDate <= today && trip.endDate >= today) return 0;
  if (trip.startDate > today) return 1;
  return 2;
}

export function sortTrips<T extends Pick<Trip, 'id' | 'startDate' | 'endDate'>>(
  trips: readonly T[],
  today: string,
): T[] {
  return [...trips].sort((left, right) => {
    const leftBucket = tripBucket(left, today);
    const rightBucket = tripBucket(right, today);
    if (leftBucket !== rightBucket) return leftBucket - rightBucket;
    if (leftBucket === 2) {
      return right.endDate.localeCompare(left.endDate) || left.id.localeCompare(right.id);
    }
    return left.startDate.localeCompare(right.startDate)
      || left.endDate.localeCompare(right.endDate)
      || left.id.localeCompare(right.id);
  });
}

export function buildTripWeekSegments(
  trip: Trip,
  grid: { gridStart: string; totalDays: number },
): TripWeekSegment[] {
  const gridStart = dayNumber(grid.gridStart);
  const tripStart = dayNumber(trip.startDate);
  const tripEnd = dayNumber(trip.endDate);
  if (
    gridStart === null
    || tripStart === null
    || tripEnd === null
    || tripEnd < tripStart
    || !Number.isInteger(grid.totalDays)
    || grid.totalDays <= 0
  ) return [];

  const gridEnd = gridStart + grid.totalDays - 1;
  const visibleStart = Math.max(gridStart, tripStart);
  const visibleEnd = Math.min(gridEnd, tripEnd);
  if (visibleStart > visibleEnd) return [];

  const firstWeek = Math.floor((visibleStart - gridStart) / 7);
  const lastWeek = Math.floor((visibleEnd - gridStart) / 7);
  const segments: TripWeekSegment[] = [];
  for (let weekIndex = firstWeek; weekIndex <= lastWeek; weekIndex += 1) {
    const weekStart = gridStart + weekIndex * 7;
    const segmentStart = Math.max(visibleStart, weekStart);
    const segmentEnd = Math.min(visibleEnd, weekStart + 6);
    segments.push({
      trip,
      weekIndex,
      startColumn: segmentStart - weekStart,
      endColumn: segmentEnd - weekStart,
      startsTrip: segmentStart === tripStart,
      endsTrip: segmentEnd === tripEnd,
      segmentStart: dateFromDayNumber(segmentStart),
      segmentEnd: dateFromDayNumber(segmentEnd),
    });
  }
  return segments;
}

function compareSegments(left: TripWeekSegment, right: TripWeekSegment): number {
  const leftLength = left.endColumn - left.startColumn;
  const rightLength = right.endColumn - right.startColumn;
  return left.startColumn - right.startColumn
    || rightLength - leftLength
    || left.trip.id.localeCompare(right.trip.id);
}

export function packTripLanes(
  trips: readonly Trip[],
  week: { weekStart: string; weekEnd: string },
): { visible: TripWeekSegment[]; overflowCount: number } {
  const start = dayNumber(week.weekStart);
  const end = dayNumber(week.weekEnd);
  if (start === null || end === null || end - start !== 6) {
    return { visible: [], overflowCount: 0 };
  }

  const candidates = trips
    .flatMap((item) => buildTripWeekSegments(item, { gridStart: week.weekStart, totalDays: 7 }))
    .sort(compareSegments);
  const laneEnds = [-1, -1];
  const visible: TripWeekSegment[] = [];
  const overflow = new Set<string>();

  candidates.forEach((segment) => {
    const lane = laneEnds.findIndex((laneEnd) => laneEnd < segment.startColumn);
    if (lane < 0) {
      overflow.add(segment.trip.id);
      return;
    }
    laneEnds[lane] = segment.endColumn;
    visible.push({ ...segment, lane });
  });

  return { visible, overflowCount: overflow.size };
}
