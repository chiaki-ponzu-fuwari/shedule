import React, { useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet,
  ScrollView, FlatList,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { colors } from '../../constants/colors';
import { RecurringSchedule, Stamp } from '../../types';
import { WEEKDAY_LABELS } from '../../utils/dateUtils';

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const CURRENT_YEAR = new Date().getFullYear();

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function RecurringModal({ visible, onClose }: Props) {
  const [selectedStamp, setSelectedStamp] = useState<Stamp | null>(null);
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [selectedMonths, setSelectedMonths] = useState<number[]>([]);
  const [stampPosition, setStampPosition] = useState<'main' | 'mini-left' | 'mini-right'>('main');
  const [targetYear, setTargetYear] = useState(CURRENT_YEAR);

  const stamps = useStampStore((s) => s.stamps);
  const addRecurring = useCalendarStore((s) => s.addRecurring);
  const applyRecurring = useCalendarStore((s) => s.applyRecurring);

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

    const schedule: RecurringSchedule = {
      id: `recurring_${Date.now()}`,
      name: `${selectedStamp.text} / ${selectedDays.map((d) => WEEKDAY_LABELS[d]).join('・')}曜`,
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
            <Text style={styles.title}>繰り返し予定を設定</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Stamp position */}
            <Text style={styles.sectionLabel}>入力する場所</Text>
            <View style={styles.positionRow}>
              {(['main', 'mini-left', 'mini-right'] as const).map((pos) => (
                <TouchableOpacity
                  key={pos}
                  style={[styles.posBtn, stampPosition === pos && styles.posBtnActive]}
                  onPress={() => { Haptics.selectionAsync(); setStampPosition(pos); }}
                >
                  <Text style={[styles.posBtnText, stampPosition === pos && styles.posBtnTextActive]}>
                    {pos === 'main' ? 'メイン帯' : pos === 'mini-left' ? 'ミニ左' : 'ミニ右'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Stamp select */}
            <Text style={styles.sectionLabel}>スタンプを選択</Text>
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
            <Text style={styles.sectionLabel}>曜日を選択</Text>
            <View style={styles.dayRow}>
              {WEEKDAY_LABELS.map((label, i) => (
                <TouchableOpacity
                  key={i}
                  style={[
                    styles.dayBtn,
                    selectedDays.includes(i) && styles.dayBtnActive,
                    i === 0 && selectedDays.includes(i) && styles.dayBtnSun,
                    i === 6 && selectedDays.includes(i) && styles.dayBtnSat,
                  ]}
                  onPress={() => toggleDay(i)}
                >
                  <Text
                    style={[
                      styles.dayBtnText,
                      selectedDays.includes(i) && styles.dayBtnTextActive,
                    ]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Target year */}
            <View style={styles.yearRow}>
              <Text style={styles.sectionLabel}>対象年</Text>
              <View style={styles.yearBtns}>
                <TouchableOpacity
                  style={[styles.yearBtn, targetYear === CURRENT_YEAR && styles.yearBtnActive]}
                  onPress={() => setTargetYear(CURRENT_YEAR)}
                >
                  <Text style={[styles.yearBtnText, targetYear === CURRENT_YEAR && styles.yearBtnTextActive]}>
                    {CURRENT_YEAR}年
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.yearBtn, targetYear === CURRENT_YEAR + 1 && styles.yearBtnActive]}
                  onPress={() => setTargetYear(CURRENT_YEAR + 1)}
                >
                  <Text style={[styles.yearBtnText, targetYear === CURRENT_YEAR + 1 && styles.yearBtnTextActive]}>
                    {CURRENT_YEAR + 1}年
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Month select */}
            <Text style={styles.sectionLabel}>適用する月を選択</Text>
            <View style={styles.monthGrid}>
              {MONTHS.map((m) => (
                <TouchableOpacity
                  key={m}
                  style={[styles.monthBtn, selectedMonths.includes(m) && styles.monthBtnActive]}
                  onPress={() => toggleMonth(m)}
                >
                  <Text style={[styles.monthBtnText, selectedMonths.includes(m) && styles.monthBtnTextActive]}>
                    {m}月
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
                  ? `${selectedMonths.length}ヶ月分に一括反映 ✓`
                  : 'スタンプ・曜日・月を選んでください'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(45,27,105,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 20, paddingBottom: 40, maxHeight: '92%',
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#E0D0F0', alignSelf: 'center', marginTop: 10, marginBottom: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  title: { fontSize: 18, fontWeight: '800', color: colors.text },
  closeBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#F0E6F0', alignItems: 'center', justifyContent: 'center' },
  closeBtnText: { fontSize: 12, color: colors.textSecondary, fontWeight: '700' },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginTop: 16, marginBottom: 8 },
  positionRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  posBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center' },
  posBtnActive: { borderColor: colors.primary, backgroundColor: '#FFE4F0' },
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
  yearBtnActive: { borderColor: colors.primary, backgroundColor: '#FFE4F0' },
  yearBtnText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  yearBtnTextActive: { color: colors.primary },
  monthGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  monthBtn: { width: '22%', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center' },
  monthBtnActive: { borderColor: colors.primary, backgroundColor: '#FFE4F0' },
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
