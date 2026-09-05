import React, { useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet,
  ScrollView, FlatList,
} from 'react-native';
import { Haptics } from '../../utils/haptics';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { colors } from '../../constants/colors';
import { RecurringSchedule, Stamp } from '../../types';
import { useTranslation } from '../../constants/i18n';

const WD_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const CURRENT_YEAR = new Date().getFullYear();

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function RecurringModal({ visible, onClose }: Props) {
  const { t, locale } = useTranslation();
  const [selectedStamp, setSelectedStamp] = useState<Stamp | null>(null);
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [selectedMonths, setSelectedMonths] = useState<number[]>([]);
  const [stampPosition, setStampPosition] = useState<'main' | 'mini-left' | 'mini-right'>('main');
  const [targetYear, setTargetYear] = useState(CURRENT_YEAR);

  const stamps = useStampStore((s) => s.stamps);
  const addRecurring = useCalendarStore((s) => s.addRecurring);
  const applyRecurring = useCalendarStore((s) => s.applyRecurring);
  const weekStartDay = useCalendarStore((s) => s.weekStartDay);

  // weekStartDayに合わせて曜日を並び替え（0=日, 1=月始まり）
  const orderedDays = Array.from({ length: 7 }, (_, i) => (weekStartDay + i) % 7);

  const toggleDay = (day: number) => {
    Haptics.selectionAsync();
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  const toggleMonth = (month: number) => {
    Haptics.selectionAsync();
    setSelectedMonths((prev) =>
      prev.includes(month) ? prev.filter((m) => m !== month) : [...prev, month]
    );
  };

  const canSave = selectedStamp && selectedDays.length > 0 && selectedMonths.length > 0;

  const handleApply = () => {
    if (!canSave || !selectedStamp) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    const dayPart = selectedDays.map((d) => t(`weekday.${WD_KEYS[d]}`)).join(locale === 'ja' ? '・' : ' · ');
    const scheduleName =
      locale === 'ja' ? `${selectedStamp.text} / ${dayPart}曜` : `${selectedStamp.text} / ${dayPart}`;
    const schedule: RecurringSchedule = {
      id: `recurring_${Date.now()}`,
      name: scheduleName,
      stampId: selectedStamp.id,
      stampPosition,
      daysOfWeek: selectedDays,
    };

    addRecurring(schedule);

    for (const month of selectedMonths) {
      applyRecurring(schedule.id, targetYear, month - 1);
    }

    // Reset
    setSelectedStamp(null);
    setSelectedDays([]);
    setSelectedMonths([]);
    onClose();
  };

  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.title}>{t('recurringModal.title')}</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Stamp position */}
            <Text style={styles.sectionLabel}>{t('recurringModal.place')}</Text>
            <View style={styles.positionRow}>
              {(['main', 'mini-left', 'mini-right'] as const).map((pos) => (
                <TouchableOpacity
                  key={pos}
                  style={[styles.posBtn, stampPosition === pos && styles.posBtnActive]}
                  onPress={() => { Haptics.selectionAsync(); setStampPosition(pos); }}
                >
                  <Text style={[styles.posBtnText, stampPosition === pos && styles.posBtnTextActive]}>
                    {pos === 'main' ? t('recurring.mainBand') : pos === 'mini-left' ? t('recurring.miniLeft') : t('recurring.miniRight')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Stamp select */}
            <Text style={styles.sectionLabel}>{t('recurringModal.pickStamp')}</Text>
            <FlatList
              data={stamps}
              keyExtractor={(s) => s.id}
              numColumns={6}
              scrollEnabled={false}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.stampItem}
                  onPress={() => { Haptics.selectionAsync(); setSelectedStamp(item); }}
                >
                  <View
                    style={[
                      styles.stampCircle,
                      { backgroundColor: item.bgColor },
                      selectedStamp?.id === item.id && styles.stampCircleSelected,
                    ]}
                  >
                    <Text style={[styles.stampText, { color: item.textColor }]}>{item.text}</Text>
                  </View>
                </TouchableOpacity>
              )}
            />

            {/* Days of week */}
            <Text style={styles.sectionLabel}>{t('recurringModal.pickWeekdays')}</Text>
            <View style={styles.dayRow}>
              {orderedDays.map((dayIndex) => (
                <TouchableOpacity
                  key={dayIndex}
                  style={[
                    styles.dayBtn,
                    selectedDays.includes(dayIndex) && styles.dayBtnActive,
                    dayIndex === 0 && selectedDays.includes(dayIndex) && styles.dayBtnSun,
                    dayIndex === 6 && selectedDays.includes(dayIndex) && styles.dayBtnSat,
                  ]}
                  onPress={() => toggleDay(dayIndex)}
                >
                  <Text
                    style={[
                      styles.dayBtnText,
                      selectedDays.includes(dayIndex) && styles.dayBtnTextActive,
                    ]}
                  >
                    {t(`weekday.${WD_KEYS[dayIndex]}`)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Target year */}
            <View style={styles.yearRow}>
              <Text style={styles.sectionLabel}>{t('recurringModal.targetYear')}</Text>
              <View style={styles.yearBtns}>
                <TouchableOpacity
                  style={[styles.yearBtn, targetYear === CURRENT_YEAR && styles.yearBtnActive]}
                  onPress={() => setTargetYear(CURRENT_YEAR)}
                >
                  <Text style={[styles.yearBtnText, targetYear === CURRENT_YEAR && styles.yearBtnTextActive]}>
                    {t('recurringModal.yearFmt', { y: CURRENT_YEAR })}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.yearBtn, targetYear === CURRENT_YEAR + 1 && styles.yearBtnActive]}
                  onPress={() => setTargetYear(CURRENT_YEAR + 1)}
                >
                  <Text style={[styles.yearBtnText, targetYear === CURRENT_YEAR + 1 && styles.yearBtnTextActive]}>
                    {t('recurringModal.yearFmt', { y: CURRENT_YEAR + 1 })}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Month select */}
            <Text style={styles.sectionLabel}>{t('recurringModal.pickMonths')}</Text>
            <View style={styles.monthGrid}>
              {MONTHS.map((m) => (
                <TouchableOpacity
                  key={m}
                  style={[styles.monthBtn, selectedMonths.includes(m) && styles.monthBtnActive]}
                  onPress={() => toggleMonth(m)}
                >
                  <Text style={[styles.monthBtnText, selectedMonths.includes(m) && styles.monthBtnTextActive]}>
                    {t('recurringModal.monthFmt', { m })}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Apply button */}
            <TouchableOpacity
              style={[styles.applyBtn, !canSave && styles.applyBtnDisabled]}
              onPress={handleApply}
              disabled={!canSave}
            >
              <Text style={styles.applyBtnText}>
                {canSave
                  ? t('recurringModal.summaryOk', { n: selectedMonths.length })
                  : t('recurringModal.summaryNeed')}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 20, paddingBottom: 40, maxHeight: '92%',
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#BFDBFE', alignSelf: 'center', marginTop: 10, marginBottom: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  title: { fontSize: 18, fontWeight: '800', color: colors.text },
  closeBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#F0E6F0', alignItems: 'center', justifyContent: 'center' },
  closeBtnText: { fontSize: 12, color: colors.textSecondary, fontWeight: '700' },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginTop: 16, marginBottom: 8 },
  positionRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  posBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center' },
  posBtnActive: { borderColor: colors.primary, backgroundColor: '#DBEAFE' },
  posBtnText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  posBtnTextActive: { color: colors.primary },
  stampItem: { width: '16.66%', alignItems: 'center', paddingVertical: 6 },
  stampCircle: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  stampCircleSelected: { borderWidth: 3, borderColor: colors.primary },
  stampText: { fontSize: 14, fontWeight: '800' },
  dayRow: { flexDirection: 'row', gap: 6, marginBottom: 4 },
  dayBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center' },
  dayBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayBtnSun: { backgroundColor: colors.sunday, borderColor: colors.sunday },
  dayBtnSat: { backgroundColor: colors.saturday, borderColor: colors.saturday },
  dayBtnText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  dayBtnTextActive: { color: '#FFFFFF' },
  yearRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  yearBtns: { flexDirection: 'row', gap: 8 },
  yearBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border },
  yearBtnActive: { borderColor: colors.primary, backgroundColor: '#DBEAFE' },
  yearBtnText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  yearBtnTextActive: { color: colors.primary },
  monthGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  monthBtn: { width: '22%', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center' },
  monthBtnActive: { borderColor: colors.primary, backgroundColor: '#DBEAFE' },
  monthBtnText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  monthBtnTextActive: { color: colors.primary },
  applyBtn: {
    backgroundColor: colors.primary, borderRadius: 16, paddingVertical: 16,
    alignItems: 'center', marginTop: 8, marginBottom: 8,
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
  },
  applyBtnDisabled: { backgroundColor: colors.textLight, shadowOpacity: 0 },
  applyBtnText: { fontSize: 15, fontWeight: '800', color: '#FFFFFF' },
});
