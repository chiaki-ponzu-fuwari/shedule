import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, Platform, TouchableOpacity,
  Modal, TouchableWithoutFeedback,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { MonthlyView } from '../../components/calendar/MonthlyView';
import { WeeklyView } from '../../components/calendar/WeeklyView';
import { DailyView } from '../../components/calendar/DailyView';
import { ViewToggle } from '../../components/ui/ViewToggle';
import { WheelPicker } from '../../components/ui/WheelPicker';
import { DayDetailSheet } from '../../components/modals/DayDetailSheet';
import { DayViewSheet } from '../../components/modals/DayViewSheet';
import { AddStampModal } from '../../components/modals/AddStampModal';
import { RecurringModal } from '../../components/modals/RecurringModal';
import { BirthdayModal } from '../../components/modals/BirthdayModal';
import { colors } from '../../constants/colors';
import { CalendarView } from '../../types';
import { formatDate } from '../../utils/dateUtils';

const TODAY = new Date();
const TODAY_STR = formatDate(TODAY);

const PICKER_YEARS = Array.from({ length: 21 }, (_, i) => 2020 + i);
const PICKER_MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

export default function CalendarScreen() {
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<CalendarView>('monthly');
  const [currentMonth, setCurrentMonth] = useState(new Date(TODAY.getFullYear(), TODAY.getMonth(), 1));
  const [currentWeekDate, setCurrentWeekDate] = useState(TODAY);
  const [selectedDate, setSelectedDate] = useState<string>(TODAY_STR);

  // Modal visibility
  const [dayViewVisible, setDayViewVisible] = useState(false);
  const [detailVisible, setDetailVisible] = useState(false);
  const [addStampVisible, setAddStampVisible] = useState(false);
  const [recurringVisible, setRecurringVisible] = useState(false);
  const [birthdayVisible, setBirthdayVisible] = useState(false);

  // 年月ピッカー
  const [monthPickerVisible, setMonthPickerVisible] = useState(false);
  const [pYear, setPYear] = useState(TODAY.getFullYear());
  const [pMonth, setPMonth] = useState(TODAY.getMonth() + 1);

  const openMonthPicker = useCallback(() => {
    setPYear(currentMonth.getFullYear());
    setPMonth(currentMonth.getMonth() + 1);
    setMonthPickerVisible(true);
  }, [currentMonth]);

  const confirmMonthPicker = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentMonth(new Date(pYear, pMonth - 1, 1));
    setMonthPickerVisible(false);
  }, [pYear, pMonth]);

  // 日付タップ → ウィークリーはそのまま選択のみ、それ以外はサマリー表示
  const handleDayPress = useCallback((dateStr: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedDate(dateStr);
    if (view !== 'weekly') setDayViewVisible(true);
  }, [view]);

  // サマリーの＋ or FAB → 入力フォーム
  const handleOpenDetail = useCallback(() => {
    setDayViewVisible(false);
    setTimeout(() => setDetailVisible(true), 250);
  }, []);

  const handleOpenAddStamp = useCallback(() => {
    setDetailVisible(false);
    setTimeout(() => setAddStampVisible(true), 300);
  }, []);

  const goToday = () => {
    Haptics.selectionAsync();
    const now = new Date();
    setCurrentMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setCurrentWeekDate(now);
    setSelectedDate(formatDate(now));
  };

  return (
    <SafeAreaView style={[styles.container, { paddingTop: Platform.OS === 'android' ? insets.top : 0 }]}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <ViewToggle value={view} onChange={setView} />

        <View style={styles.topActions}>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => { Haptics.selectionAsync(); setBirthdayVisible(true); }}
          >
            <Ionicons name="gift-outline" size={18} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => { Haptics.selectionAsync(); setRecurringVisible(true); }}
          >
            <Ionicons name="repeat" size={18} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={goToday}
          >
            <Text style={styles.todayLabel}>今日</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Calendar views */}
      <View style={styles.calendarArea}>
        {view === 'monthly' && (
          <MonthlyView
            currentMonth={currentMonth}
            selectedDate={selectedDate}
            onDayPress={handleDayPress}
            onMonthChange={setCurrentMonth}
            onPickerOpen={openMonthPicker}
          />
        )}
        {view === 'weekly' && (
          <WeeklyView
            currentDate={currentWeekDate}
            selectedDate={selectedDate}
            onDayPress={handleDayPress}
            onWeekChange={setCurrentWeekDate}
          />
        )}
        {view === 'daily' && (
          <DailyView
            currentDate={selectedDate}
            onDayChange={setSelectedDate}
            onStampPress={() => setDetailVisible(true)}
          />
        )}
      </View>

      {/* FAB – 直接入力フォームを開く */}
      {view !== 'daily' && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            setSelectedDate(selectedDate || TODAY_STR);
            setDetailVisible(true);
          }}
        >
          <Text style={styles.fabIcon}>＋</Text>
        </TouchableOpacity>
      )}

      {/* Modals */}
      <DayViewSheet
        visible={dayViewVisible}
        date={selectedDate}
        onClose={() => setDayViewVisible(false)}
        onEdit={handleOpenDetail}
        onDateChange={setSelectedDate}
      />
      <DayDetailSheet
        visible={detailVisible}
        date={selectedDate}
        onClose={() => setDetailVisible(false)}
        onOpenAddStamp={handleOpenAddStamp}
        onDateChange={setSelectedDate}
      />
      <AddStampModal
        visible={addStampVisible}
        onClose={() => setAddStampVisible(false)}
      />
      <RecurringModal
        visible={recurringVisible}
        onClose={() => setRecurringVisible(false)}
      />
      <BirthdayModal
        visible={birthdayVisible}
        onClose={() => setBirthdayVisible(false)}
      />

      {/* ── 年月ピッカー（トップレベルModal）── */}
      <Modal
        transparent
        animationType="fade"
        visible={monthPickerVisible}
        onRequestClose={() => setMonthPickerVisible(false)}
      >
        <TouchableWithoutFeedback onPress={() => setMonthPickerVisible(false)}>
          <View style={styles.pickerOverlay}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={styles.pickerCard}>
                <Text style={styles.pickerTitle}>年月を選択</Text>
                <View style={styles.pickerRow}>
                  <WheelPicker
                    items={PICKER_YEARS}
                    selectedIndex={PICKER_YEARS.indexOf(pYear) >= 0 ? PICKER_YEARS.indexOf(pYear) : 0}
                    onChange={(i) => setPYear(PICKER_YEARS[i])}
                    formatItem={(v) => `${v}年`}
                    width={110}
                  />
                  <WheelPicker
                    items={PICKER_MONTHS}
                    selectedIndex={pMonth - 1}
                    onChange={(i) => setPMonth(PICKER_MONTHS[i])}
                    formatItem={(v) => `${v}月`}
                    width={88}
                  />
                </View>
                <View style={styles.pickerBtns}>
                  <TouchableOpacity
                    style={styles.pickerCancelBtn}
                    onPress={() => setMonthPickerVisible(false)}
                  >
                    <Text style={styles.pickerCancelText}>キャンセル</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.pickerConfirmBtn}
                    onPress={confirmMonthPicker}
                  >
                    <Text style={styles.pickerConfirmText}>決定</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    shadowColor: '#A78BFA',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 3,
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#F5EFF5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnEmoji: { fontSize: 16 },
  todayLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primary,
  },
  calendarArea: { flex: 1 },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  fabIcon: { fontSize: 28, color: '#FFFFFF', lineHeight: 32 },

  // 年月ピッカー
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(45,27,105,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pickerCard: {
    backgroundColor: '#FDFAFF',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 10,
    minWidth: 280,
  },
  pickerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.text,
    marginBottom: 16,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  pickerBtns: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },
  pickerCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#F5EFF5',
    alignItems: 'center',
  },
  pickerCancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  pickerConfirmBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
  pickerConfirmText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#FFFFFF',
  },
});
