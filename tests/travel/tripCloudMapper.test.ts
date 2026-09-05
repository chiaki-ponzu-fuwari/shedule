import type { Trip, TripItem } from '../../types/travel';
import {
  tripFromCloudPayload,
  tripItemFromCloudPayload,
  tripItemToCloudPayload,
  tripToCloudPayload,
} from '../../lib/account/tripMapper';
import { createPortableSnapshot } from '../../lib/account/personalSnapshot';

const trip: Trip = {
  id: 'trip-1',
  title: '台北',
  startDate: '2026-10-02',
  endDate: '2026-10-05',
  color: '#2563EB',
  startIcon: 'plane',
  endIcon: 'train',
  memo: '家族旅行',
  createdAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:00:00.000Z',
  revision: 2,
};

const item: TripItem = {
  id: 'item-1',
  tripId: trip.id,
  type: 'flight',
  localDate: '2026-10-02',
  arrivalLocalDate: '2026-10-02',
  allDay: false,
  startsAtUtc: '2026-10-02T01:15:00.000Z',
  endsAtUtc: '2026-10-02T05:00:00.000Z',
  departureTimezone: 'Asia/Tokyo',
  arrivalTimezone: 'Asia/Taipei',
  departure: 'HND',
  arrival: 'TSA',
  reservationNumber: 'ABC123',
  url: 'https://airline.example/booking',
  memo: '窓側',
  sortOrder: 10,
  notificationId: 'device-only-notification',
};

describe('travel cloud mapper', () => {
  test('round-trips a trip through the portable allow-list', () => {
    expect(tripFromCloudPayload(trip.id, tripToCloudPayload(trip))).toEqual(trip);
  });

  test('preserves UTC instants and IANA timezones but removes device-only values', () => {
    const payload = tripItemToCloudPayload(item);
    expect(payload).not.toHaveProperty('notificationId');
    expect(payload).not.toHaveProperty('localUri');
    expect(payload).not.toHaveProperty('oauthToken');
    expect(payload.startsAtUtc).toBe(item.startsAtUtc);
    expect(payload.arrivalLocalDate).toBe('2026-10-02');
    expect(payload.departureTimezone).toBe('Asia/Tokyo');
    expect(tripItemFromCloudPayload(item.id, payload)).toEqual({
      ...item,
      notificationId: undefined,
    });
  });

  test('rejects unknown icons, item types, and unsafe URLs from cloud payloads', () => {
    expect(() => tripFromCloudPayload('trip-1', { ...trip, startIcon: 'rocket' }))
      .toThrow('Invalid trip');
    expect(() => tripItemFromCloudPayload('item-1', { ...item, type: 'secret' }))
      .toThrow('Invalid trip item');
    expect(() => tripItemFromCloudPayload('item-1', { ...item, url: 'javascript:alert(1)' }))
      .toThrow('Invalid trip item URL');
  });

  test('rejects malformed timestamps and non-string URLs from cloud payloads', () => {
    expect(() => tripFromCloudPayload('trip-1', { ...trip, updatedAt: 'eventually' }))
      .toThrow('Invalid trip');
    expect(() => tripItemFromCloudPayload('item-1', { ...item, url: 123 }))
      .toThrow('Invalid trip item');
    expect(() => tripItemFromCloudPayload('item-1', {
      ...item,
      arrivalLocalDate: '2026-02-30',
    })).toThrow('Invalid trip item');
  });

  test('accepts legacy trip items that do not have an arrival local date', () => {
    const { arrivalLocalDate: _legacyMissing, ...legacy } = item;
    expect(tripItemFromCloudPayload(item.id, legacy)).not.toHaveProperty('arrivalLocalDate');
  });

  test('quarantines malformed outbound travel instead of silently dropping it', () => {
    expect(() => createPortableSnapshot({
      entries: {},
      specialDates: [],
      preferences: {},
      stamps: [],
      trips: [{ ...trip, startDate: '2026-02-30' }],
      tripItems: [],
    })).toThrow(/quarantin/i);

    expect(() => createPortableSnapshot({
      entries: {},
      specialDates: [],
      preferences: {},
      stamps: [],
      trips: [trip],
      tripItems: [{ ...item, type: 'spaceship' }],
    })).toThrow(/quarantin/i);
  });

  test('validates UTC instants and normalizes URL and IANA timezones on outbound mapping', () => {
    expect(() => tripItemToCloudPayload({
      ...item,
      startsAtUtc: '2026-10-02T10:15:00+09:00',
    })).toThrow('Invalid trip item');
    expect(() => tripToCloudPayload({
      ...trip,
      createdAt: '2026-02-30T10:00:00.000Z',
    })).toThrow('Invalid trip');
    expect(() => tripItemToCloudPayload({
      ...item,
      startsAtUtc: '2026-02-30T10:00:00.000Z',
    })).toThrow('Invalid trip item');

    expect(tripItemToCloudPayload({
      ...item,
      url: ' airline.example/booking ',
      departureTimezone: ' Asia/Tokyo ',
      arrivalTimezone: ' Asia/Taipei ',
    })).toMatchObject({
      url: 'https://airline.example/booking',
      departureTimezone: 'Asia/Tokyo',
      arrivalTimezone: 'Asia/Taipei',
    });
  });

  test('requires each outbound itinerary item to have an active parent covering both dates', () => {
    const base = {
      entries: {},
      specialDates: [],
      preferences: {},
      stamps: [],
      trips: [trip],
    };
    expect(() => createPortableSnapshot({
      ...base,
      tripItems: [{ ...item, tripId: 'missing-trip' }],
    })).toThrow(/parent/i);
    expect(() => createPortableSnapshot({
      ...base,
      tripItems: [{ ...item, arrivalLocalDate: '2026-10-06' }],
    })).toThrow(/period/i);
  });
});
