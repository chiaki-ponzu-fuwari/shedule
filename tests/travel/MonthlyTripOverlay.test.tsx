jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-crypto', () => ({ randomUUID: () => 'overlay-install' }));
jest.mock('@expo/vector-icons', () => {
  const ReactModule = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  return { Ionicons: ({ testID }: { testID?: string }) => ReactModule.createElement(View, { testID }) };
});
jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native') as typeof import('react-native');
  return { LinearGradient: View };
});

import React from 'react';
import { render } from '@testing-library/react-native';
import { StyleSheet, TouchableOpacity } from 'react-native';
import { DayCell } from '../../components/calendar/DayCell';
import { MonthlyView } from '../../components/calendar/MonthlyView';
import { TripWeekOverlay } from '../../components/calendar/TripWeekOverlay';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { useTripStore } from '../../store/tripStore';
import type { Trip } from '../../types/travel';

function trip(
  id: string,
  startDate: string,
  endDate: string,
  startIcon: Trip['startIcon'] = 'none',
  endIcon: Trip['endIcon'] = 'none',
): Trip {
  return {
    id,
    title: id,
    startDate,
    endDate,
    color: '#2563EB',
    startIcon,
    endIcon,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    revision: 1,
  };
}

describe('monthly travel route overlay', () => {
  beforeEach(() => {
    useTripStore.setState({ trips: [], items: [] });
    useCalendarStore.setState({ entries: {}, specialDates: [], recurringSchedules: [], weekStartDay: 1 });
  });

  test('draws two thin lanes, tiny endpoint transport marks, and one overflow count', () => {
    const screen = render(
      <TripWeekOverlay
        trips={[
          trip('plane-trip', '2026-09-07', '2026-09-10', 'plane', 'train'),
          trip('car-trip', '2026-09-08', '2026-09-11', 'car', 'car'),
          trip('extra-trip', '2026-09-09', '2026-09-12'),
        ]}
        weekStart="2026-09-07"
        weekEnd="2026-09-13"
        width={350}
      />,
    );

    expect(screen.getAllByTestId(/^travel-line-/)).toHaveLength(2);
    expect(screen.getByTestId('travel-start-plane-trip-plane')).toBeTruthy();
    expect(screen.getByTestId('travel-end-plane-trip-train')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    const secondLaneMark = StyleSheet.flatten(
      screen.getByTestId('travel-start-car-trip-car').props.style,
    );
    expect(secondLaneMark.top + secondLaneMark.height).toBeLessThanOrEqual(8);
  });

  test('keeps both endpoint marks visible for a one-day trip', () => {
    const screen = render(
      <TripWeekOverlay
        trips={[trip('day-trip', '2026-09-09', '2026-09-09', 'plane', 'train')]}
        weekStart="2026-09-07"
        weekEnd="2026-09-13"
        width={350}
      />,
    );

    const startMarkStyle = StyleSheet.flatten(
      screen.getByTestId('travel-start-day-trip-plane').props.style,
    );
    const endMarkStyle = StyleSheet.flatten(
      screen.getByTestId('travel-end-day-trip-train').props.style,
    );
    expect(startMarkStyle.left).not.toBe(endMarkStyle.left);
  });

  test('keeps special-date, note, mini, and main schedule marks in the dense cell', () => {
    const screen = render(
      <DayCell
        day={{
          date: new Date(2026, 8, 7),
          dateString: '2026-09-07',
          isToday: false,
          isCurrentMonth: true,
          isSunday: false,
          isSaturday: false,
          specialDate: {
            id: 'birthday', name: '誕生日', month: 9, day: 7,
            color: '#2563EB', type: 'birthday',
          },
        }}
        entry={{ date: '2026-09-07', miniStamps: { left: 'mini' }, privacyLevel: 2, notes: '予定' }}
        mainStamp={{ id: 'main', text: '出', bgColor: '#2563EB', textColor: '#FFFFFF' }}
        leftMiniStamp={{ id: 'mini', text: '旅', bgColor: '#93C5FD', textColor: '#0F172A' }}
        onPress={jest.fn()}
        isSelected={false}
        hasNotes
        cellWidth={48}
      />,
    );
    expect(screen.getByTestId('special-date-dot')).toBeTruthy();
    expect(screen.getByTestId('notes-dot')).toBeTruthy();
    expect(screen.getByTestId('mini-stamp-band-left')).toBeTruthy();
    expect(screen.getByTestId('main-stamp-band')).toBeTruthy();
    const cellStyle = StyleSheet.flatten(screen.UNSAFE_getByType(TouchableOpacity).props.style);
    expect(cellStyle.height).toBeGreaterThanOrEqual(69);
  });

  test('integrates travel routes into the matching calendar week', () => {
    useTripStore.setState({ trips: [trip('calendar-trip', '2026-09-07', '2026-09-10', 'plane', 'train')], items: [] });
    useStampStore.setState({ stamps: [] });
    const screen = render(
      <MonthlyView
        currentMonth={new Date(2026, 8, 1)}
        selectedDate={null}
        onDayPress={jest.fn()}
        onMonthChange={jest.fn()}
      />,
    );

    expect(screen.getByTestId('travel-line-calendar-trip')).toBeTruthy();
    expect(screen.getByTestId('travel-start-calendar-trip-plane')).toBeTruthy();
    expect(screen.getByTestId('travel-end-calendar-trip-train')).toBeTruthy();
  });
});
