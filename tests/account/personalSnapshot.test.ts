import { DayEntry, SpecialDate, Stamp } from '../../types';
import {
  createPortableCalendarEntry,
  createPortableSnapshot,
} from '../../lib/account/personalSnapshot';

describe('portable personal snapshots', () => {
  test('removes device-only values from cloud calendar payloads', () => {
    const entry: DayEntry = {
      date: '2026-09-05',
      miniStamps: {},
      privacyLevel: 2,
      notificationId: 'local-notification',
      imageUri: 'file:///private/photo.jpg',
      diaryPhotos: [
        'file:///private/diary.jpg',
        'https://storage.example.test/signed-photo.jpg',
        'user-a/diary/11111111-1111-4111-8111-111111111111.jpg',
      ],
      noteItems: [{
        id: 'n1',
        text: 'Flight',
        notificationId: 'n2',
        googlePushFingerprint: 'device-fingerprint',
        url: 'content://local/boarding-pass',
      }],
      timeSlots: [{
        id: 't1',
        startTime: '09:00',
        endTime: '10:00',
        title: 'Boarding',
        color: '#123456',
        notificationId: 'n3',
      }],
    };

    const payload = createPortableCalendarEntry(entry);

    expect(payload).not.toHaveProperty('notificationId');
    expect(payload.imageUri).toBeUndefined();
    expect(payload.diaryPhotos).toEqual([
      'user-a/diary/11111111-1111-4111-8111-111111111111.jpg',
    ]);
    expect(payload.noteItems?.[0]).not.toHaveProperty('notificationId');
    expect(payload.noteItems?.[0]).not.toHaveProperty('googlePushFingerprint');
    expect(payload.noteItems?.[0]).not.toHaveProperty('url');
    expect(payload.noteItems?.[0].text).toBe('Flight');
    expect(payload.timeSlots?.[0]).not.toHaveProperty('notificationId');
  });

  test('creates a deep copy without mutating Zustand state', () => {
    const entry: DayEntry = {
      date: '2026-09-05',
      miniStamps: { left: 'work' },
      privacyLevel: 2,
      noteItems: [{ id: 'n1', text: 'Original', notificationId: 'local' }],
    };

    const payload = createPortableCalendarEntry(entry);
    payload.noteItems![0].text = 'Changed';

    expect(entry.noteItems?.[0]).toEqual({
      id: 'n1',
      text: 'Original',
      notificationId: 'local',
    });
  });

  test('keeps only media keys owned by the selected account and expected field domain', () => {
    const snapshot = createPortableSnapshot({
      entries: {
        '2026-09-05': {
          date: '2026-09-05',
          miniStamps: {},
          privacyLevel: 2,
          imageUri: 'user-b/calendar/11111111-1111-4111-8111-111111111111.jpg',
          diaryPhotos: [
            'user-a/calendar/22222222-2222-4222-8222-222222222222.jpg',
            'user-a/diary/33333333-3333-4333-8333-333333333333.jpg',
          ],
        },
        '2026-09-06': {
          date: '2026-09-06',
          miniStamps: {},
          privacyLevel: 2,
          imageUri: 'user-a/stamp/55555555-5555-4555-8555-555555555555.jpg',
        },
      },
      specialDates: [],
      preferences: {},
      stamps: [{
        id: 'photo',
        text: '',
        bgColor: '#fff',
        textColor: '#000',
        imageUri: 'user-a/diary/44444444-4444-4444-8444-444444444444.jpg',
      }],
      trips: [],
      tripItems: [],
    }, 'user-a');

    expect(snapshot.entries['2026-09-05'].imageUri).toBeUndefined();
    expect(snapshot.entries['2026-09-06'].imageUri).toBe(
      'user-a/stamp/55555555-5555-4555-8555-555555555555.jpg',
    );
    expect(snapshot.entries['2026-09-05'].diaryPhotos).toEqual([
      'user-a/diary/33333333-3333-4333-8333-333333333333.jpg',
    ]);
    expect(snapshot.stamps[0].imageUri).toBeUndefined();
  });

  test('sanitizes local image stamps and secret-shaped preference fields', () => {
    const imageStamp: Stamp = {
      id: 'custom-image',
      text: '',
      bgColor: '#FFFFFF',
      textColor: '#000000',
      isImageStamp: true,
      imageUri: 'content://local/image',
    };

    const snapshot = createPortableSnapshot({
      entries: {},
      specialDates: [],
      preferences: {
        weekStartDay: 1,
        accessToken: 'must-not-upload',
        googleAccessToken: 'must-not-upload',
        oauthRefreshToken: 'must-not-upload',
        refresh_token: 'must-not-upload-either',
        transientModalOpen: true,
        isModalOpen: true,
        selectedDate: '2026-09-05',
      },
      stamps: [imageStamp],
      trips: [],
      tripItems: [],
    });

    expect(snapshot.stamps[0].imageUri).toBeUndefined();
    expect(snapshot.preferences).toEqual({ weekStartDay: 1 });
    expect(imageStamp.imageUri).toBe('content://local/image');
  });

  test('keeps portable arrival-local-date metadata for cross-zone itinerary items', () => {
    const snapshot = createPortableSnapshot({
      entries: {},
      specialDates: [],
      preferences: {},
      stamps: [],
      trips: [{
        id: 'trip-1',
        title: 'ロサンゼルスから東京',
        startDate: '2026-10-02',
        endDate: '2026-10-04',
        color: '#2563EB',
        startIcon: 'plane',
        endIcon: 'plane',
        createdAt: '2026-09-05T00:00:00.000Z',
        updatedAt: '2026-09-05T00:00:00.000Z',
        revision: 1,
      }],
      tripItems: [{
        id: 'flight-1',
        tripId: 'trip-1',
        type: 'flight',
        localDate: '2026-10-02',
        arrivalLocalDate: '2026-10-04',
        allDay: false,
        startsAtUtc: '2026-10-03T06:30:00.000Z',
        endsAtUtc: '2026-10-03T20:00:00.000Z',
        departureTimezone: 'America/Los_Angeles',
        arrivalTimezone: 'Asia/Tokyo',
        sortOrder: 0,
        notificationId: 'device-only',
      }],
    });

    expect(snapshot.tripItems[0]).toEqual(expect.objectContaining({
      arrivalLocalDate: '2026-10-04',
      departureTimezone: 'America/Los_Angeles',
      arrivalTimezone: 'Asia/Tokyo',
    }));
    expect(snapshot.tripItems[0]).not.toHaveProperty('notificationId');
  });

  test('allow-lists special dates and rejects forbidden portable fields at compile time', () => {
    const legacySpecialDate = {
      id: 'birthday-1',
      name: 'Birthday',
      month: 9,
      day: 5,
      color: '#123456',
      type: 'birthday',
      googleAccessToken: 'legacy-secret',
      isModalOpen: true,
    } as SpecialDate & { googleAccessToken: string; isModalOpen: boolean };
    const snapshot = createPortableSnapshot({
      entries: {},
      specialDates: [legacySpecialDate],
      preferences: {},
      stamps: [],
      trips: [],
      tripItems: [],
    });

    expect(snapshot.specialDates[0]).toEqual({
      id: 'birthday-1',
      name: 'Birthday',
      month: 9,
      day: 5,
      color: '#123456',
      type: 'birthday',
    });

    if (false) {
      const portable = createPortableCalendarEntry({
        date: '2026-09-05',
        miniStamps: {},
        privacyLevel: 2,
      });
      // @ts-expect-error Device notification IDs are not part of the cloud DTO.
      portable.notificationId = 'forbidden';
      // @ts-expect-error Nested Google push fingerprints are not part of the cloud DTO.
      portable.noteItems = [{ id: 'n1', text: 'x', googlePushFingerprint: 'forbidden' }];
    }
  });
});
