import {
  TripTimeZoneError,
  normalizeIanaTimeZone,
  zonedDateTimeParts,
  zonedLocalDateTimeToUtc,
} from '../../utils/tripTimezone';

describe('trip timezone conversion', () => {
  test('converts local dates in independent IANA timezones to UTC', () => {
    expect(zonedLocalDateTimeToUtc('2026-10-02', '10:15', 'Asia/Tokyo'))
      .toBe('2026-10-02T01:15:00.000Z');
    expect(zonedLocalDateTimeToUtc('2026-10-04', '05:00', 'Asia/Tokyo'))
      .toBe('2026-10-03T20:00:00.000Z');
    expect(zonedLocalDateTimeToUtc('2026-10-02', '23:30', 'America/Los_Angeles'))
      .toBe('2026-10-03T06:30:00.000Z');
  });

  test('rejects a local time skipped by the DST spring-forward gap', () => {
    expect(() => zonedLocalDateTimeToUtc(
      '2026-03-08',
      '02:30',
      'America/New_York',
    )).toThrow(expect.objectContaining<Partial<TripTimeZoneError>>({
      code: 'nonexistent-local-time',
    }));
  });

  test('requires an explicit choice when a local time repeats in the DST fall-back fold', () => {
    expect(() => zonedLocalDateTimeToUtc(
      '2026-11-01',
      '01:30',
      'America/New_York',
    )).toThrow(expect.objectContaining<Partial<TripTimeZoneError>>({
      code: 'ambiguous-local-time',
    }));
    expect(zonedLocalDateTimeToUtc(
      '2026-11-01',
      '01:30',
      'America/New_York',
      'earlier',
    )).toBe('2026-11-01T05:30:00.000Z');
    expect(zonedLocalDateTimeToUtc(
      '2026-11-01',
      '01:30',
      'America/New_York',
      'later',
    )).toBe('2026-11-01T06:30:00.000Z');
  });

  test('validates and canonicalizes IANA timezones without accepting arbitrary text', () => {
    expect(normalizeIanaTimeZone(' Asia/Tokyo ')).toBe('Asia/Tokyo');
    expect(normalizeIanaTimeZone('US/Eastern')).toBe('America/New_York');
    expect(normalizeIanaTimeZone('Tokyo time')).toBeNull();
    expect(normalizeIanaTimeZone('')).toBeNull();
  });

  test('recovers the arrival local date and time from a stored UTC instant', () => {
    expect(zonedDateTimeParts('2026-10-03T20:00:00.000Z', 'Asia/Tokyo')).toEqual({
      date: '2026-10-04',
      time: '05:00',
    });
  });

  test('rejects malformed date, time, timezone, and instant inputs', () => {
    expect(() => zonedLocalDateTimeToUtc('2026-02-30', '09:00', 'Asia/Tokyo'))
      .toThrow(expect.objectContaining({ code: 'invalid-date' }));
    expect(() => zonedLocalDateTimeToUtc('2026-02-28', '9:00', 'Asia/Tokyo'))
      .toThrow(expect.objectContaining({ code: 'invalid-time' }));
    expect(() => zonedLocalDateTimeToUtc('2026-02-28', '09:00', 'Tokyo time'))
      .toThrow(expect.objectContaining({ code: 'invalid-timezone' }));
    expect(() => zonedDateTimeParts('not-an-instant', 'Asia/Tokyo'))
      .toThrow(expect.objectContaining({ code: 'invalid-instant' }));
  });
});
