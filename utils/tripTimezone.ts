import { isValidLocalDate } from './tripUtils';

export type TripTimeZoneErrorCode =
  | 'invalid-date'
  | 'invalid-time'
  | 'invalid-timezone'
  | 'invalid-instant'
  | 'nonexistent-local-time'
  | 'ambiguous-local-time';

export type TripLocalTimeDisambiguation = 'earlier' | 'later';

export interface TripLocalTimeChoice {
  disambiguation: TripLocalTimeDisambiguation;
  instant: string;
  offsetLabel: string;
}

export class TripTimeZoneError extends Error {
  constructor(public readonly code: TripTimeZoneErrorCode) {
    super(code);
    this.name = 'TripTimeZoneError';
  }
}

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const OFFSET_SAMPLE_HOURS = 48;

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

function partsAt(instant: Date, timeZone: string): LocalParts {
  const values = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function parseRequestedLocalDateTime(date: string, time: string): LocalParts {
  if (!isValidLocalDate(date)) throw new TripTimeZoneError('invalid-date');
  if (!TIME_PATTERN.test(time)) throw new TripTimeZoneError('invalid-time');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return { year, month, day, hour, minute, second: 0 };
}

function sameLocalParts(left: LocalParts, right: LocalParts) {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function partsAsUtc(parts: LocalParts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

export function normalizeIanaTimeZone(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100 || /[\u0000-\u001F\u007F\s]/.test(normalized)) {
    return null;
  }
  try {
    return formatter(normalized).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function deviceTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return normalizeIanaTimeZone(resolved || '') ?? 'UTC';
}

function offsetLabel(offsetMs: number) {
  const totalMinutes = Math.round(offsetMs / 60_000);
  const sign = totalMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(totalMinutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

export function zonedLocalDateTimeChoices(
  date: string,
  time: string,
  timeZoneInput: string,
): TripLocalTimeChoice[] {
  const requested = parseRequestedLocalDateTime(date, time);
  const timeZone = normalizeIanaTimeZone(timeZoneInput);
  if (!timeZone) throw new TripTimeZoneError('invalid-timezone');

  const wallClockAsUtc = partsAsUtc(requested);
  const candidateOffsets = new Set<number>();
  for (let hours = -OFFSET_SAMPLE_HOURS; hours <= OFFSET_SAMPLE_HOURS; hours += 3) {
    const sampleMs = wallClockAsUtc + hours * 60 * 60 * 1_000;
    const sample = new Date(sampleMs);
    const offset = partsAsUtc(partsAt(sample, timeZone)) - sampleMs;
    candidateOffsets.add(offset);
  }

  const matches = [...candidateOffsets]
    .map((offset) => new Date(wallClockAsUtc - offset))
    .filter((candidate) => sameLocalParts(partsAt(candidate, timeZone), requested))
    .sort((left, right) => left.getTime() - right.getTime());
  if (matches.length === 0) throw new TripTimeZoneError('nonexistent-local-time');
  return matches.map((candidate, index) => ({
    disambiguation: index === 0 ? 'earlier' : 'later',
    instant: candidate.toISOString(),
    offsetLabel: offsetLabel(wallClockAsUtc - candidate.getTime()),
  }));
}

/**
 * Converts a wall-clock value in an IANA zone to UTC without consulting the
 * device timezone. DST gaps and unconfirmed repeated (fold) times are rejected.
 */
export function zonedLocalDateTimeToUtc(
  date: string,
  time: string,
  timeZoneInput: string,
  disambiguation?: TripLocalTimeDisambiguation,
): string {
  const choices = zonedLocalDateTimeChoices(date, time, timeZoneInput);
  if (choices.length > 1 && !disambiguation) {
    throw new TripTimeZoneError('ambiguous-local-time');
  }
  const choice = disambiguation === 'later' ? choices.at(-1) : choices[0];
  if (!choice) throw new TripTimeZoneError('nonexistent-local-time');
  return choice.instant;
}

export function zonedDateTimeParts(
  utcInstant: string,
  timeZoneInput: string,
): { date: string; time: string } {
  const instant = new Date(utcInstant);
  if (!utcInstant.endsWith('Z') || !Number.isFinite(instant.getTime())) {
    throw new TripTimeZoneError('invalid-instant');
  }
  const timeZone = normalizeIanaTimeZone(timeZoneInput);
  if (!timeZone) throw new TripTimeZoneError('invalid-timezone');
  const parts = partsAt(instant, timeZone);
  return {
    date: [parts.year, parts.month, parts.day]
      .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, '0'))
      .join('-'),
    time: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
  };
}
