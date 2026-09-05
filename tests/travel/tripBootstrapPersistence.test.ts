jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-crypto', () => ({ randomUUID: () => 'bootstrap-trip-install' }));

import { snapshotFromCloudRows } from '../../lib/account/accountBootstrapPersistence';
import type { CloudRow } from '../../lib/account/cloudRepository';

function row(entity: 'trip' | 'trip-item', id: string, payload: Record<string, unknown>): CloudRow {
  return {
    ownerId: 'user-1',
    entity,
    id,
    revision: 1,
    payload,
    updatedAt: '2026-09-05T00:00:00.000Z',
    schemaVersion: 1,
  };
}

test('cloud restore rejects unknown travel enums and unsafe itinerary URLs', () => {
  expect(() => snapshotFromCloudRows([row('trip-item', 'item-1', {
    tripId: 'trip-1',
    type: 'unknown-kind',
    localDate: '2026-09-10',
    allDay: true,
    sortOrder: 0,
  })])).toThrow('Invalid trip item');

  expect(() => snapshotFromCloudRows([row('trip-item', 'item-2', {
    tripId: 'trip-1',
    type: 'hotel',
    localDate: '2026-09-10',
    allDay: true,
    sortOrder: 0,
    url: 'javascript:alert(1)',
  })])).toThrow('Invalid trip item URL');
});

const validTripPayload = {
  title: '台北',
  startDate: '2026-09-10',
  endDate: '2026-09-12',
  color: '#2563EB',
  startIcon: 'plane',
  endIcon: 'train',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  revision: 1,
};

const validItemPayload = {
  tripId: 'trip-1',
  type: 'flight',
  localDate: '2026-09-10',
  arrivalLocalDate: '2026-09-12',
  allDay: false,
  startsAtUtc: '2026-09-10T01:00:00.000Z',
  endsAtUtc: '2026-09-10T05:00:00.000Z',
  departureTimezone: 'Asia/Tokyo',
  arrivalTimezone: 'Asia/Taipei',
  sortOrder: 0,
};

test('cloud restore rejects orphan and out-of-period trip items', () => {
  expect(() => snapshotFromCloudRows([
    row('trip-item', 'orphan', validItemPayload),
  ])).toThrow(/active parent/i);

  expect(() => snapshotFromCloudRows([
    row('trip', 'trip-1', validTripPayload),
    row('trip-item', 'outside', { ...validItemPayload, localDate: '2026-09-13' }),
  ])).toThrow(/outside.*period/i);

  expect(() => snapshotFromCloudRows([
    row('trip', 'trip-1', validTripPayload),
    row('trip-item', 'arrival-outside', {
      ...validItemPayload,
      arrivalLocalDate: '2026-09-13',
    }),
  ])).toThrow(/outside.*period/i);
});

test('cloud restore accepts an itinerary whose parent covers both local dates', () => {
  expect(snapshotFromCloudRows([
    row('trip', 'trip-1', validTripPayload),
    row('trip-item', 'item-1', validItemPayload),
  ]).tripItems).toHaveLength(1);
});
