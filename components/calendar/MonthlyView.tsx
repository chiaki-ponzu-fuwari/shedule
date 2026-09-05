import React, { useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  PanResponder, useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Haptics } from '../../utils/haptics';
import { DayCell, DAY_CELL_MARGIN_H } from './DayCell';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { getMonthDays, getMonthLabel, addMonths, getWeekdayLabels } from '../../utils/dateUtils';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import { DayEntry } from '../../types';

interface Props {
  currentMonth: Date;
  selectedDate: string | null;
  onDayPress: (dateStr: string) => void;
  onMonthChange: (newMonth: Date) => void;
  onPickerOpen?: () => void;
}

export function MonthlyView({ currentMonth, selectedDate, onDayPress, onMonthChange, onPickerOpen }: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const [gridWidth, setGridWidth] = useState<number | null>(null);
  const widthForCells = gridWidth ?? windowWidth;
  const cellWidth = Math.max(1, Math.floor((widthForCells - DAY_CELL_MARGIN_H * 2 * 7) / 7));

  const { locale } = useTranslation();
  const entries = useCalendarStore((s) => s.entries);
  const specialDates = useCalendarStore((s) => s.specialDates);
  const recurringSchedules = useCalendarStore((s) => s.recurringSchedules);
  const weekStartDay = useCalendarStore((s) => s.weekStartDay);
  const getStamp = useStampStore((s) => s.getStamp);

  const getDisplayStampId = (entry: DayEntry | undefined, position: 'main' | 'mini-left' | 'mini-right') => {
    if (position === 'main') return entry?.mainStampId;
    if (position === 'mini-left') return entry?.miniStamps?.left;
    return entry?.miniStamps?.right;
  };

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const days = getMonthDays(year, month, specialDates, weekStartDay);
  const weekdays = getWeekdayLabels(weekStartDay, locale);

  // 左右スワイプで月移動
  const swipeStartX = useRef(0);
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 12 && Math.abs(gs.dx) > Math.abs(gs.dy) * 2.5,
      onPanResponderGrant: (_, gs) => {
        swipeStartX.current = gs.x0;
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dx < -50) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onMonthChange(addMonths(currentMonth, 1));
        } else if (gs.dx > 50) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onMonthChange(addMonths(currentMonth, -1));
        }
      },
    })
  ).current;

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      {/* ── 月ヘッダー ── */}
      <LinearGradient
        colors={['#DBEAFE', '#EFF6FF']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.header}
      >
        <TouchableOpacity
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onMonthChange(addMonths(currentMonth, -1)); }}
          style={styles.navBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-back" size={20} color={colors.primary} />
        </TouchableOpacity>

        <TouchableOpacity onPress={() => { Haptics.selectionAsync(); onPickerOpen?.(); }}>
          <Text style={styles.monthLabel}>{getMonthLabel(year, month, locale)}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onMonthChange(addMonths(currentMonth, 1)); }}
          style={styles.navBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-forward" size={20} color={colors.primary} />
        </TouchableOpacity>
      </LinearGradient>

      {/* ── 曜日ヘッダー ── */}
      <View style={styles.weekHeader}>
        {weekdays.map(({ label, day }) => (
          <View key={day} style={styles.weekHeaderCell}>
            <Text
              style={[
                styles.weekHeaderText,
                day === 6 && { color: colors.saturday },
                day === 0 && { color: colors.sunday },
              ]}
            >
              {label}
            </Text>
          </View>
        ))}
      </View>

      {/* ── 日付グリッド ── */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={scrollContentStyle}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={styles.grid}
          onLayout={(e) => {
            const w = e.nativeEvent.layout.width;
            if (w > 0) setGridWidth(w);
          }}
        >
          {days.map((day) => {
            const entry = entries[day.dateString];
            const mainId = getDisplayStampId(entry, 'main');
            const leftId = getDisplayStampId(entry, 'mini-left');
            const rightId = getDisplayStampId(entry, 'mini-right');
            return (
              <DayCell
                key={day.dateString}
                day={day}
                entry={entry}
                mainStamp={mainId ? getStamp(mainId) : undefined}
                leftMiniStamp={leftId ? getStamp(leftId) : undefined}
                rightMiniStamp={rightId ? getStamp(rightId) : undefined}
                onPress={() => onDayPress(day.dateString)}
                isSelected={selectedDate === day.dateString}
                imageUri={entry?.imageUri}
                hasNotes={!!(entry?.notes || (entry?.noteItems && entry.noteItems.length > 0))}
                cellWidth={cellWidth}
              />
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const scrollContentStyle = { width: '100%' as const, flexGrow: 1 as const };

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8F4FC',
  },
  // 月ヘッダー
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  navBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthLabel: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.text,
    letterSpacing: 0.5,
  },
  // 曜日行
  weekHeader: {
    flexDirection: 'row',
    backgroundColor: '#FAFAFA',
    borderBottomWidth: 1,
    borderBottomColor: '#EEE5F5',
    paddingVertical: 6,
  },
  weekHeaderCell: {
    width: '14.2857%',
    alignItems: 'center',
  },
  weekHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  // グリッド
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: '100%',
    backgroundColor: '#F0EBF8',
    paddingVertical: 1,
  },
});
