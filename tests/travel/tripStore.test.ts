jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-crypto', () => {
  let sequence = 0;
  return { randomUUID: () => `travel-test-${++sequence}` };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, waitFor } from '@testing-library/react-native';
import {
  createTripOwnerSwitchTarget,
  useTripStore,
} from '../../store/tripStore';
import {
  getPersonalOwnerStorage,
  switchOwnerAndRehydrate,
} from '../../lib/account/namespacedStorage';

const baseDraft = {
  title: '北海道',
  startDate: '2026-10-01',
  endDate: '2026-10-04',
  color: '#2563EB',
  startIcon: 'plane' as const,
  endIcon: 'train' as const,
};

describe('owner-scoped trip store', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useTripStore.getState().replaceState({ trips: [], items: [] });
  });

  test('creates, edits, and deletes a trip with its itinerary', () => {
    let createdId = '';
    act(() => {
      createdId = useTripStore.getState().addTrip(baseDraft).id;
    });
    expect(useTripStore.getState().trips[0]).toEqual(expect.objectContaining({
      id: createdId,
      title: '北海道',
      revision: 1,
    }));

    let itemId = '';
    act(() => {
      itemId = useTripStore.getState().addItem(createdId, {
        type: 'hotel',
        localDate: '2026-10-01',
        allDay: true,
        place: '札幌ホテル',
        reservationNumber: 'R-123',
        sortOrder: 20,
      }).id;
      useTripStore.getState().updateTrip(createdId, { ...baseDraft, title: '北海道旅行' });
      useTripStore.getState().updateItem(itemId, {
        type: 'hotel',
        localDate: '2026-10-02',
        allDay: true,
        place: '小樽ホテル',
        sortOrder: 10,
      });
    });

    expect(useTripStore.getState().trips[0]).toEqual(expect.objectContaining({
      title: '北海道旅行',
      revision: 2,
    }));
    expect(useTripStore.getState().items[0]).toEqual(expect.objectContaining({
      id: itemId,
      place: '小樽ホテル',
    }));

    act(() => useTripStore.getState().deleteTrip(createdId));
    expect(useTripStore.getState().trips).toEqual([]);
    expect(useTripStore.getState().items).toEqual([]);
  });

  test('validates itinerary dates and URLs without discarding the trip', () => {
    const trip = useTripStore.getState().addTrip(baseDraft);
    expect(() => useTripStore.getState().addItem(trip.id, {
      type: 'memo',
      localDate: '2026-10-05',
      allDay: true,
      url: 'javascript:alert(1)',
      sortOrder: 0,
    })).toThrow('outside the trip');
    expect(useTripStore.getState().trips).toHaveLength(1);
    expect(useTripStore.getState().items).toEqual([]);
  });

  test('stores independent departure and arrival local dates and IANA timezones', () => {
    const trip = useTripStore.getState().addTrip(baseDraft);
    const flight = useTripStore.getState().addItem(trip.id, {
      type: 'flight',
      localDate: '2026-10-02',
      arrivalLocalDate: '2026-10-04',
      allDay: false,
      startsAtUtc: '2026-10-03T06:30:00.000Z',
      endsAtUtc: '2026-10-03T20:00:00.000Z',
      departureTimezone: 'America/Los_Angeles',
      arrivalTimezone: 'Asia/Tokyo',
      sortOrder: 0,
    });

    expect(flight).toEqual(expect.objectContaining({
      localDate: '2026-10-02',
      arrivalLocalDate: '2026-10-04',
      departureTimezone: 'America/Los_Angeles',
      arrivalTimezone: 'Asia/Tokyo',
    }));
  });

  test('rejects invalid arrival dates and timezones at the store boundary', () => {
    const trip = useTripStore.getState().addTrip(baseDraft);
    const draft = {
      type: 'flight' as const,
      localDate: '2026-10-02',
      arrivalLocalDate: '2026-10-04',
      allDay: false,
      startsAtUtc: '2026-10-03T06:30:00.000Z',
      endsAtUtc: '2026-10-03T20:00:00.000Z',
      departureTimezone: 'America/Los_Angeles',
      arrivalTimezone: 'Asia/Tokyo',
      sortOrder: 0,
    };

    expect(() => useTripStore.getState().addItem(trip.id, {
      ...draft,
      arrivalLocalDate: '2026-02-30',
    })).toThrow('Invalid trip item arrival date');
    expect(() => useTripStore.getState().addItem(trip.id, {
      ...draft,
      departureTimezone: 'Los Angeles time',
    })).toThrow('Invalid trip item departure timezone');
  });

  test('orders itinerary by local date, time, sort order, then stable id', () => {
    const trip = useTripStore.getState().addTrip(baseDraft);
    const late = useTripStore.getState().addItem(trip.id, {
      type: 'event', localDate: '2026-10-02', allDay: false,
      startsAtUtc: '2026-10-02T10:00:00.000Z', sortOrder: 1,
    });
    const early = useTripStore.getState().addItem(trip.id, {
      type: 'event', localDate: '2026-10-01', allDay: true, sortOrder: 9,
    });
    expect(useTripStore.getState().items.map((item) => item.id)).toEqual([early.id, late.id]);
  });

  test('does not strand itinerary items when the trip period is shortened', () => {
    const trip = useTripStore.getState().addTrip(baseDraft);
    useTripStore.getState().addItem(trip.id, {
      type: 'hotel', localDate: '2026-10-04', allDay: true, sortOrder: 0,
    });

    expect(() => useTripStore.getState().updateTrip(trip.id, {
      ...baseDraft,
      endDate: '2026-10-02',
    })).toThrow('outside the new trip period');
    expect(useTripStore.getState().trips[0].endDate).toBe('2026-10-04');
  });

  test('does not strand a destination-local arrival date when the trip is shortened', () => {
    const trip = useTripStore.getState().addTrip(baseDraft);
    useTripStore.getState().addItem(trip.id, {
      type: 'flight',
      localDate: '2026-10-02',
      arrivalLocalDate: '2026-10-04',
      allDay: false,
      departureTimezone: 'Asia/Tokyo',
      arrivalTimezone: 'America/Los_Angeles',
      sortOrder: 0,
    });

    expect(() => useTripStore.getState().updateTrip(trip.id, {
      ...baseDraft,
      endDate: '2026-10-03',
    })).toThrow('outside the new trip period');
    expect(useTripStore.getState().trips[0].endDate).toBe('2026-10-04');
  });

  test('rejects orphan and out-of-period rows at replaceFromCloud without changing visible state', () => {
    const existing = useTripStore.getState().addTrip(baseDraft);
    const orphan = {
      id: 'orphan-item',
      tripId: 'missing-trip',
      type: 'hotel' as const,
      localDate: '2026-10-02',
      allDay: true,
      sortOrder: 0,
    };
    expect(() => useTripStore.getState().replaceFromCloud([], [orphan]))
      .toThrow(/active parent/i);
    expect(useTripStore.getState().trips).toEqual([existing]);

    expect(() => useTripStore.getState().replaceFromCloud([existing], [{
      ...orphan,
      tripId: existing.id,
      localDate: '2026-10-05',
    }])).toThrow(/outside.*period/i);
    expect(useTripStore.getState().trips).toEqual([existing]);
  });

  test('rehydrates a different owner without exposing the previous owner data', async () => {
    const ownerStorage = getPersonalOwnerStorage(AsyncStorage);
    await ownerStorage.getOwner();
    act(() => { useTripStore.getState().addTrip(baseDraft); });
    await waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalled();
    });

    await act(async () => {
      await switchOwnerAndRehydrate({
        ownerStorage,
        owner: { kind: 'user', id: 'user-b' },
        targets: [createTripOwnerSwitchTarget()],
      });
    });
    expect(useTripStore.getState().trips).toEqual([]);

    act(() => { useTripStore.getState().addTrip({ ...baseDraft, title: '沖縄' }); });
    await act(async () => {
      await switchOwnerAndRehydrate({
        ownerStorage,
        owner: { kind: 'user', id: 'user-c' },
        targets: [createTripOwnerSwitchTarget()],
      });
    });
    expect(useTripStore.getState().trips).toEqual([]);
    expect(await AsyncStorage.getItem('recoto:user:user-b:trips')).toContain('沖縄');
    expect(await AsyncStorage.getItem('recoto:user:user-c:trips')).toBeNull();
  });
});
