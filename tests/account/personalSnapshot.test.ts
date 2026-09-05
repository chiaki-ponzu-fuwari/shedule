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
    expect(payload.diaryPhotos).toEqual(['https://storage.example.test/signed-photo.jpg']);
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
