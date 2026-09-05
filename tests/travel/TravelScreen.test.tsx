jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-crypto', () => {
  let sequence = 0;
  return { randomUUID: () => `travel-screen-${++sequence}` };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Alert, TouchableOpacity } from 'react-native';
import TravelScreen from '../../app/(tabs)/travel';
import { useLocaleStore } from '../../store/localeStore';
import { useTripStore } from '../../store/tripStore';
import type { Trip } from '../../types/travel';

const tokyoTrip = (): Trip => ({
  id: 'trip-tokyo',
  title: '東京旅行',
  startDate: '2026-09-10',
  endDate: '2026-09-12',
  color: '#2563EB',
  startIcon: 'plane',
  endIcon: 'train',
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  revision: 1,
});

describe('Travel screen', () => {
  beforeEach(() => {
    useLocaleStore.setState({ locale: 'ja' });
    useTripStore.getState().replaceState({ trips: [], items: [] });
  });

  test('explains the empty state and opens the accessible add sheet', () => {
    const screen = render(<TravelScreen />);
    expect(screen.getByText('旅行の予定をひとまとめに')).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: '旅行を追加' }));
    expect(screen.getByLabelText('旅行を追加ダイアログ').type).toBe('Text');
    expect(screen.getByLabelText('旅行名')).toBeTruthy();
  });

  test('saves a trip and shows its period, color, and endpoint transport', () => {
    const screen = render(<TravelScreen />);
    fireEvent.press(screen.getByRole('button', { name: '旅行を追加' }));
    fireEvent.changeText(screen.getByLabelText('旅行名'), '京都旅行');
    fireEvent.press(screen.getByRole('button', { name: '行き：飛行機' }));
    fireEvent.press(screen.getByRole('button', { name: '帰り：電車' }));
    fireEvent.press(screen.getByRole('button', { name: '旅行を保存' }));

    expect(screen.getByText('京都旅行')).toBeTruthy();
    expect(screen.getByRole('button', {
      name: /京都旅行.*行き：飛行機.*帰り：電車/,
    })).toBeTruthy();
  });

  test('shows only fields relevant to the selected itinerary type', () => {
    useTripStore.setState({ trips: [tokyoTrip()], items: [] });
    const screen = render(<TravelScreen />);
    fireEvent.press(screen.getByText('東京旅行'));
    fireEvent.press(screen.getByRole('button', { name: '旅程を追加' }));

    fireEvent.press(screen.getByRole('button', { name: 'フライト' }));
    expect(screen.getByLabelText('出発地')).toBeTruthy();
    expect(screen.getByLabelText('到着地')).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: 'ホテル' }));
    expect(screen.queryByLabelText('出発地')).toBeNull();
    expect(screen.getByLabelText('施設名')).toBeTruthy();
  });

  test('keeps the draft and explains how to fix an unsafe URL', () => {
    useTripStore.setState({ trips: [tokyoTrip()], items: [] });
    const screen = render(<TravelScreen />);
    fireEvent.press(screen.getByText('東京旅行'));
    fireEvent.press(screen.getByRole('button', { name: '旅程を追加' }));
    fireEvent.changeText(screen.getByLabelText('URL'), 'javascript:alert(1)');
    fireEvent.press(screen.getByRole('button', { name: '旅程を保存' }));

    expect(screen.getByText('http または https のURLを入力してください')).toBeTruthy();
    expect(screen.getByDisplayValue('javascript:alert(1)')).toBeTruthy();
  });

  test('asks before discarding a changed itinerary draft', () => {
    useTripStore.setState({ trips: [tokyoTrip()], items: [] });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    const screen = render(<TravelScreen />);
    fireEvent.press(screen.getByText('東京旅行'));
    fireEvent.press(screen.getByRole('button', { name: '旅程を追加' }));
    fireEvent.changeText(screen.getByLabelText('出発地'), '羽田');
    const closeButtons = screen.getAllByRole('button', { name: '閉じる' });
    fireEvent.press(closeButtons[closeButtons.length - 1]);

    expect(alert).toHaveBeenCalledWith(
      '入力内容を破棄しますか？',
      'まだ保存されていない変更があります。',
      expect.any(Array),
    );
    alert.mockRestore();
  });

  test('does not rewrite restored flight instants when editing another field', () => {
    useTripStore.setState({
      trips: [tokyoTrip()],
      items: [{
        id: 'flight-zones',
        tripId: 'trip-tokyo',
        type: 'flight',
        localDate: '2026-09-10',
        allDay: false,
        startsAtUtc: '2026-09-10T00:00:00.000Z',
        endsAtUtc: '2026-09-10T02:00:00.000Z',
        departureTimezone: 'Asia/Tokyo',
        arrivalTimezone: 'Asia/Taipei',
        departure: '羽田',
        arrival: '松山',
        reservationNumber: 'OLD',
        sortOrder: 0,
      }],
    });
    const screen = render(<TravelScreen />);
    fireEvent.press(screen.getByText('東京旅行'));
    fireEvent.press(screen.getByRole('button', { name: 'フライト: 羽田 → 松山' }));
    fireEvent.changeText(screen.getByLabelText('予約番号'), 'NEW');
    fireEvent.press(screen.getByRole('button', { name: '旅程を保存' }));

    expect(useTripStore.getState().items[0]).toEqual(expect.objectContaining({
      startsAtUtc: '2026-09-10T00:00:00.000Z',
      endsAtUtc: '2026-09-10T02:00:00.000Z',
      departureTimezone: 'Asia/Tokyo',
      arrivalTimezone: 'Asia/Taipei',
      reservationNumber: 'NEW',
    }));
  });

  test('shows the destination-local arrival date when an itinerary crosses days', () => {
    useTripStore.setState({
      trips: [tokyoTrip()],
      items: [{
        id: 'overnight-flight',
        tripId: 'trip-tokyo',
        type: 'flight',
        localDate: '2026-09-10',
        arrivalLocalDate: '2026-09-11',
        allDay: false,
        startsAtUtc: '2026-09-10T23:30:00.000Z',
        endsAtUtc: '2026-09-11T05:00:00.000Z',
        departureTimezone: 'UTC',
        arrivalTimezone: 'UTC',
        departure: 'A',
        arrival: 'B',
        sortOrder: 0,
      }],
    });

    const screen = render(<TravelScreen />);
    fireEvent.press(screen.getByText('東京旅行'));

    expect(screen.getByText('23:30 – 9月11日 05:00')).toBeTruthy();
  });

  test('keeps the itinerary link outside the edit button', () => {
    useTripStore.setState({
      trips: [tokyoTrip()],
      items: [{
        id: 'flight-1',
        tripId: 'trip-tokyo',
        type: 'flight',
        localDate: '2026-09-10',
        allDay: true,
        departure: '羽田',
        arrival: '伊丹',
        url: 'https://example.com/',
        sortOrder: 0,
      }],
    });
    const screen = render(<TravelScreen />);
    fireEvent.press(screen.getByText('東京旅行'));

    const link = screen.getByRole('link', { name: 'リンクを開く' });
    const ancestorTypes: unknown[] = [];
    let ancestor = link.parent;
    while (ancestor) {
      ancestorTypes.push(ancestor.type);
      ancestor = ancestor.parent;
    }
    expect(ancestorTypes.filter((type) => type === TouchableOpacity)).toHaveLength(1);
  });

  test('renders English travel copy from the shared locale', () => {
    useLocaleStore.setState({ locale: 'en' });
    const screen = render(<TravelScreen />);
    expect(screen.getByText('Keep every part of your trip together')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add trip' })).toBeTruthy();
  });
});
