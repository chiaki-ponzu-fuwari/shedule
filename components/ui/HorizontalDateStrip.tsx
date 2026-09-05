import React, { useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  NativeSyntheticEvent,
  NativeScrollEvent,
  StyleProp,
  TextStyle,
} from 'react-native';
import { Haptics } from '../../utils/haptics';
import { useTranslation } from '../../constants/i18n';
import { colors } from '../../constants/colors';
import {
  formatDate,
  parseDate,
  addDays,
  daysBetweenCalendar,
  formatShortDateParts,
} from '../../utils/dateUtils';
import type { AppLocale } from '../../store/localeStore';

const DAY_W = 54;
const STRIP_ANCHOR = new Date(2020, 0, 1);
const TOTAL_DAYS = 8000;

const STRIP_INDICES = Array.from({ length: TOTAL_DAYS }, (_, i) => i);

function dayIndexToDateStr(index: number): string {
  return formatDate(addDays(STRIP_ANCHOR, index));
}

function dateStrToDayIndex(dateStr: string): number {
  const d = parseDate(dateStr);
  let idx = daysBetweenCalendar(STRIP_ANCHOR, d);
  if (idx < 0) idx = 0;
  if (idx >= TOTAL_DAYS) idx = TOTAL_DAYS - 1;
  return idx;
}

interface ItemProps {
  index: number;
  selectedDate: string;
  todayStr: string;
  locale: AppLocale;
  onPick: (ds: string) => void;
}

/** M/D を「数字＋スラッシュ」のみで表示（iOS の日付自動変換を避ける） */
function NumericMD({ style, month, day }: { style?: StyleProp<TextStyle>; month: number; day: number }) {
  return (
    <Text style={style} allowFontScaling={false}>
      <Text>{String(month)}</Text>
      <Text>/</Text>
      <Text>{String(day)}</Text>
    </Text>
  );
}

function StripDayChip({ index, selectedDate, todayStr, locale, onPick }: ItemProps) {
  const ds = dayIndexToDateStr(index);
  const { day: wd } = formatShortDateParts(ds, locale);
  const cal = parseDate(ds);
  const mo = cal.getMonth() + 1;
  const dom = cal.getDate();
  const isSel = ds === selectedDate;
  const isToday = ds === todayStr;

  return (
    <TouchableOpacity
      style={[styles.chip, isSel && styles.chipSelected]}
      onPress={() => { Haptics.selectionAsync(); onPick(ds); }}
      activeOpacity={0.75}
    >
      <Text
        style={[styles.chipWd, isSel && styles.chipWdSel, isToday && !isSel && styles.chipTodayWd]}
        allowFontScaling={false}
      >
        {wd}
      </Text>
      <NumericMD month={mo} day={dom} style={[styles.chipMd, isSel && styles.chipMdSel]} />
      {isToday && <View style={[styles.todayDot, isSel && styles.todayDotOnSel]} />}
    </TouchableOpacity>
  );
}

interface Props {
  selectedDate: string;
  onDateChange: (dateStr: string) => void;
}

export function HorizontalDateStrip({ selectedDate, onDateChange }: Props) {
  const { locale } = useTranslation();
  const listRef = useRef<FlatList<number>>(null);
  const fromUserRef = useRef(false);
  const todayStr = formatDate(new Date());

  const scrollToDate = useCallback((dateStr: string, animated: boolean) => {
    const idx = dateStrToDayIndex(dateStr);
    listRef.current?.scrollToIndex({ index: idx, animated, viewPosition: 0.5 });
  }, []);

  useEffect(() => {
    if (fromUserRef.current) {
      fromUserRef.current = false;
      return;
    }
    scrollToDate(selectedDate, false);
  }, [selectedDate, scrollToDate]);

  const commitOffset = useCallback((x: number) => {
    const idx = Math.round(x / DAY_W);
    const clamped = Math.max(0, Math.min(TOTAL_DAYS - 1, idx));
    const ds = dayIndexToDateStr(clamped);
    if (ds !== selectedDate) {
      fromUserRef.current = true;
      onDateChange(ds);
      Haptics.selectionAsync();
    }
  }, [selectedDate, onDateChange]);

  const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    commitOffset(e.nativeEvent.contentOffset.x);
  };

  return (
    <View style={styles.wrap}>
      <FlatList
        ref={listRef}
        data={STRIP_INDICES}
        extraData={selectedDate}
        horizontal
        keyExtractor={(i) => String(i)}
        showsHorizontalScrollIndicator={false}
        snapToInterval={DAY_W}
        snapToAlignment="start"
        decelerationRate="fast"
        getItemLayout={(_, index) => ({
          length: DAY_W,
          offset: DAY_W * index,
          index,
        })}
        onMomentumScrollEnd={onScrollEnd}
        onScrollEndDrag={onScrollEnd}
        initialScrollIndex={dateStrToDayIndex(selectedDate)}
        onScrollToIndexFailed={(info) => {
          setTimeout(() => {
            listRef.current?.scrollToIndex({
              index: info.index,
              animated: false,
              viewPosition: 0.5,
            });
          }, 120);
        }}
        renderItem={({ item: index }) => (
          <StripDayChip
            index={index}
            selectedDate={selectedDate}
            todayStr={todayStr}
            locale={locale}
            onPick={(ds) => {
              fromUserRef.current = true;
              onDateChange(ds);
              scrollToDate(ds, true);
            }}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: -16,
    paddingBottom: 4,
  },
  chip: {
    width: DAY_W,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderRadius: 12,
  },
  chipSelected: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 2,
  },
  chipWd: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textSecondary,
    marginBottom: 2,
  },
  chipWdSel: { color: colors.primary, fontWeight: '800' },
  chipTodayWd: { color: colors.primary },
  chipMd: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
  },
  chipMdSel: { color: colors.primary, fontWeight: '800' },
  todayDot: {
    marginTop: 3,
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  todayDotOnSel: {
    backgroundColor: colors.primaryDark,
  },
});
