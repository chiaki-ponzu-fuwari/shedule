jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-crypto', () => ({ randomUUID: () => 'timezone-form-item' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../components/travel/TravelDateField', () => {
  const ReactModule = require('react') as typeof import('react');
  const { TextInput } = require('react-native') as typeof import('react-native');
  return {
    TravelDateField: ({ label, value, onChange }: {
      label: string;
      value: string;
      onChange(value: string): void;
    }) => ReactModule.createElement(TextInput, {
      accessibilityLabel: label,
      value,
      onChangeText: onChange,
    }),
  };
});

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { TripItemFormSheet } from '../../components/travel/TripItemFormSheet';
import { useLocaleStore } from '../../store/localeStore';
import { useTripStore } from '../../store/tripStore';
import type { Trip, TripItem } from '../../types/travel';

const trip = (overrides: Partial<Trip> = {}): Trip => ({
  id: 'timezone-trip',
  title: '海外旅行',
  startDate: '2026-10-01',
  endDate: '2026-10-05',
  color: '#2563EB',
  startIcon: 'plane',
  endIcon: 'plane',
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  revision: 1,
  ...overrides,
});

describe('trip itinerary timezone form', () => {
  beforeEach(() => {
    useLocaleStore.setState({ locale: 'ja' });
    useTripStore.getState().replaceState({ trips: [trip()], items: [] });
  });

  test('saves a cross-zone, cross-date flight from local departure and arrival values', () => {
    const screen = render(
      <TripItemFormSheet visible trip={trip()} onClose={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByLabelText('出発日'), '2026-10-02');
    fireEvent.changeText(screen.getByLabelText('出発時刻'), '23:30');
    fireEvent.changeText(screen.getByLabelText('到着時刻'), '05:00');
    fireEvent.press(screen.getByRole('button', { name: '日付・タイムゾーンを変更' }));
    fireEvent.changeText(screen.getByLabelText('到着日'), '2026-10-04');
    fireEvent.changeText(
      screen.getByLabelText('出発地のタイムゾーン'),
      'America/Los_Angeles',
    );
    fireEvent.changeText(screen.getByLabelText('到着地のタイムゾーン'), 'Asia/Tokyo');
    fireEvent.press(screen.getByRole('button', { name: '旅程を保存' }));

    expect(useTripStore.getState().items[0]).toEqual(expect.objectContaining({
      localDate: '2026-10-02',
      arrivalLocalDate: '2026-10-04',
      startsAtUtc: '2026-10-03T06:30:00.000Z',
      endsAtUtc: '2026-10-03T20:00:00.000Z',
      departureTimezone: 'America/Los_Angeles',
      arrivalTimezone: 'Asia/Tokyo',
    }));
  });

  test('explains a nonexistent DST local time without closing or losing the draft', () => {
    const springTrip = trip({ startDate: '2026-03-07', endDate: '2026-03-09' });
    useTripStore.getState().replaceState({ trips: [springTrip], items: [] });
    const onClose = jest.fn();
    const screen = render(
      <TripItemFormSheet visible trip={springTrip} onClose={onClose} />,
    );

    fireEvent.changeText(screen.getByLabelText('出発日'), '2026-03-08');
    fireEvent.changeText(screen.getByLabelText('出発時刻'), '02:30');
    fireEvent.changeText(screen.getByLabelText('到着時刻'), '04:00');
    fireEvent.press(screen.getByRole('button', { name: '日付・タイムゾーンを変更' }));
    fireEvent.changeText(screen.getByLabelText('到着日'), '2026-03-08');
    fireEvent.changeText(screen.getByLabelText('出発地のタイムゾーン'), 'America/New_York');
    fireEvent.changeText(screen.getByLabelText('到着地のタイムゾーン'), 'America/New_York');
    fireEvent.press(screen.getByRole('button', { name: '旅程を保存' }));

    expect(screen.getByText('夏時間の切り替えで存在しない時刻です。別の時刻を入力してください')).toBeTruthy();
    expect(screen.getByDisplayValue('02:30')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('asks which repeated DST time the traveler means and stores the chosen instant', () => {
    const foldTrip = trip({ startDate: '2026-10-31', endDate: '2026-11-02' });
    useTripStore.getState().replaceState({ trips: [foldTrip], items: [] });
    const screen = render(
      <TripItemFormSheet visible trip={foldTrip} onClose={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByLabelText('出発日'), '2026-11-01');
    fireEvent.changeText(screen.getByLabelText('出発時刻'), '01:30');
    fireEvent.changeText(screen.getByLabelText('到着時刻'), '03:00');
    fireEvent.press(screen.getByRole('button', { name: '日付・タイムゾーンを変更' }));
    fireEvent.changeText(screen.getByLabelText('到着日'), '2026-11-01');
    fireEvent.changeText(screen.getByLabelText('出発地のタイムゾーン'), 'America/New_York');
    fireEvent.changeText(screen.getByLabelText('到着地のタイムゾーン'), 'America/New_York');

    expect(screen.getByRole('button', { name: '1回目（UTC-04:00）' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '2回目（UTC-05:00）' })).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: '旅程を保存' }));
    expect(screen.getByText('同じ時刻が2回あります。UTC差を確認して選んでください')).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: '2回目（UTC-05:00）' }));
    fireEvent.press(screen.getByRole('button', { name: '旅程を保存' }));
    expect(useTripStore.getState().items[0]?.startsAtUtc)
      .toBe('2026-11-01T06:30:00.000Z');
  });

  test('derives a missing legacy arrival date from the arrival instant and timezone', () => {
    const legacy: TripItem = {
      id: 'legacy-flight',
      tripId: 'timezone-trip',
      type: 'flight',
      localDate: '2026-10-02',
      allDay: false,
      startsAtUtc: '2026-10-03T06:30:00.000Z',
      endsAtUtc: '2026-10-03T20:00:00.000Z',
      departureTimezone: 'America/Los_Angeles',
      arrivalTimezone: 'Asia/Tokyo',
      sortOrder: 0,
    };
    useTripStore.getState().replaceState({ trips: [trip()], items: [legacy] });
    const screen = render(
      <TripItemFormSheet visible trip={trip()} item={legacy} onClose={jest.fn()} />,
    );

    fireEvent.press(screen.getByRole('button', { name: '日付・タイムゾーンを変更' }));
    expect(screen.getByLabelText('到着日').props.value).toBe('2026-10-04');
  });

  test('ignores hidden timezone details when a route is saved without times', () => {
    const screen = render(
      <TripItemFormSheet visible trip={trip()} onClose={jest.fn()} />,
    );
    fireEvent.press(screen.getByRole('button', { name: '日付・タイムゾーンを変更' }));
    fireEvent.changeText(screen.getByLabelText('到着日'), 'not-a-date');
    fireEvent.changeText(screen.getByLabelText('出発地のタイムゾーン'), 'not a zone');
    fireEvent(screen.getByLabelText('時刻なし'), 'valueChange', true);
    fireEvent.press(screen.getByRole('button', { name: '旅程を保存' }));

    expect(useTripStore.getState().items[0]).toEqual(expect.objectContaining({
      allDay: true,
      startsAtUtc: undefined,
      endsAtUtc: undefined,
      departureTimezone: undefined,
      arrivalTimezone: undefined,
      arrivalLocalDate: undefined,
    }));
  });
});
