import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TouchableWithoutFeedback,
  StyleSheet, Animated, Dimensions, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { WheelPicker } from '../ui/WheelPicker';
import { colors } from '../../constants/colors';
import { formatFullDate, addDays, formatDate, parseDate } from '../../utils/dateUtils';

const { height: SCREEN_H } = Dimensions.get('window');
const SHEET_H = SCREEN_H * 0.52;

const PICKER_YEARS = Array.from({ length: 21 }, (_, i) => 2020 + i);
const PICKER_MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const MONTH_DAYS = [31,29,31,30,31,30,31,31,30,31,30,31];

interface Props {
  visible: boolean;
  date: string;
  onClose: () => void;
  onEdit: () => void;
  onDateChange: (newDate: string) => void;
}

export function DayViewSheet({ visible, date, onClose, onEdit, onDateChange }: Props) {
  const goDay = (n: number) => {
    Haptics.selectionAsync();
    onDateChange(formatDate(addDays(parseDate(date), n)));
  };
  const slideAnim = useRef(new Animated.Value(SHEET_H)).current;

  const entry = useCalendarStore((s) => s.getEntry(date));
  const specialDates = useCalendarStore((s) => s.specialDates);
  const getStamp = useStampStore((s) => s.getStamp);

  const mainStamp = entry?.mainStampId ? getStamp(entry.mainStampId) : undefined;
  const leftMini = entry?.miniStamps?.left ? getStamp(entry.miniStamps.left) : undefined;
  const rightMini = entry?.miniStamps?.right ? getStamp(entry.miniStamps.right) : undefined;
  const hasNoteItems = (entry?.noteItems?.length ?? 0) > 0;
  const hasContent = mainStamp || leftMini || rightMini || entry?.notes || hasNoteItems || entry?.startTime || entry?.endTime || entry?.imageUri;

  const d = parseDate(date);
  const daySpecials = specialDates.filter((sd) => sd.month === d.getMonth() + 1 && sd.day === d.getDate());

  // 年月日ピッカー
  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [pYear, setPYear] = useState(2026);
  const [pMonth, setPMonth] = useState(1);
  const [pDay, setPDay] = useState(1);

  const openDatePicker = () => {
    const dd = parseDate(date);
    setPYear(dd.getFullYear());
    setPMonth(dd.getMonth() + 1);
    setPDay(dd.getDate());
    setDatePickerVisible(true);
  };

  const confirmDatePicker = () => {
    const maxDay = MONTH_DAYS[pMonth - 1];
    const day = Math.min(pDay, maxDay);
    const newDate = `${pYear}-${String(pMonth).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onDateChange(newDate);
    setDatePickerVisible(false);
  };

  const pickerDays = Array.from({ length: MONTH_DAYS[pMonth - 1] }, (_, i) => i + 1);

  useEffect(() => {
    if (visible) {
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 120,
        friction: 14,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: SHEET_H,
        duration: 220,
        useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  const handleEdit = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onEdit();
  };

  return (
    <Modal
      transparent
      animationType="none"
      visible={visible}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback onPress={() => {}}>
            <Animated.View style={[styles.sheet, { transform: [{ translateY: slideAnim }] }]}>
              {/* Handle */}
              <View style={styles.handle} />

              {/* Header */}
              <View style={styles.header}>
                <TouchableOpacity style={styles.arrowBtn} onPress={() => goDay(-1)}>
                  <Text style={styles.arrowText}>‹</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={openDatePicker} style={{ flex: 1 }}>
                  <Text style={styles.dateText}>{formatFullDate(date)}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.arrowBtn} onPress={() => goDay(1)}>
                  <Text style={styles.arrowText}>›</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Text style={styles.closeBtnText}>✕</Text>
                </TouchableOpacity>
              </View>

              {hasContent ? (
                <View style={styles.content}>
                  {/* スタンプ */}
                  {(mainStamp || leftMini || rightMini) && (
                    <View style={styles.stampRow}>
                      {leftMini && (
                        <View style={[styles.miniChip, { backgroundColor: leftMini.bgColor }]}>
                          <Text style={[styles.miniChipText, { color: leftMini.textColor }]}>{leftMini.text}</Text>
                        </View>
                      )}
                      {rightMini && (
                        <View style={[styles.miniChip, { backgroundColor: rightMini.bgColor }]}>
                          <Text style={[styles.miniChipText, { color: rightMini.textColor }]}>{rightMini.text}</Text>
                        </View>
                      )}
                      {mainStamp && (
                        <View style={[styles.mainChip, { backgroundColor: mainStamp.bgColor }]}>
                          <Text style={[styles.mainChipText, { color: mainStamp.textColor }]}>{mainStamp.text}</Text>
                        </View>
                      )}
                    </View>
                  )}

                  {/* 時間 */}
                  {(entry?.startTime || entry?.endTime) && (
                    <View style={styles.infoRow}>
                      <Text style={styles.infoIcon}>🕐</Text>
                      <Text style={styles.infoText}>
                        {entry.startTime || '--:--'} 〜 {entry.endTime || '--:--'}
                      </Text>
                    </View>
                  )}

                  {/* 画像スタンプ */}
                  {entry?.imageUri && (
                    <View style={styles.infoRow}>
                      {entry.imageUri.startsWith('icon://') ? (
                        <View style={styles.imageThumbIcon}>
                          <Ionicons name={entry.imageUri.replace('icon://', '') as any} size={28} color={colors.primary} />
                        </View>
                      ) : (
                        <Image source={{ uri: entry.imageUri }} style={styles.imageThumb} />
                      )}
                    </View>
                  )}

                  {/* メモ・予定リスト */}
                  {hasNoteItems && (
                    <View style={styles.notesBox}>
                      {entry!.noteItems!.map((item, idx) => (
                        <View key={idx} style={[styles.noteItemRow, idx > 0 && { borderTopWidth: 1, borderTopColor: '#EDE9FE', marginTop: 6, paddingTop: 6 }]}>
                          <Ionicons name="ellipse" size={6} color={colors.primary} style={{ marginTop: 7 }} />
                          <Text style={styles.notesText}>{item}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                  {/* 旧フォーマットのメモ（互換） */}
                  {!hasNoteItems && entry?.notes ? (
                    <View style={styles.notesBox}>
                      <Text style={styles.notesText}>{entry.notes}</Text>
                    </View>
                  ) : null}

                  {/* 通知 */}
                  {entry?.notificationEnabled && (
                    <View style={styles.infoRow}>
                      <Text style={styles.infoText}>通知ON</Text>
                    </View>
                  )}
                </View>
              ) : (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyText}>この日の予定はまだありません</Text>
                </View>
              )}

              {/* 誕生日・記念日 */}
              {daySpecials.length > 0 && (
                <View style={styles.specialList}>
                  {daySpecials.map((sd) => (
                    <View key={sd.id} style={[styles.specialItem, { borderLeftColor: sd.color }]}>
                      <Ionicons name={(sd.emoji as any) || 'gift-outline'} size={16} color={sd.color} />
                      <Text style={[styles.specialName, { color: sd.color }]}>{sd.name}</Text>
                    </View>
                  ))}
                </View>
              )}

              {/* ＋ 編集ボタン */}
              <TouchableOpacity style={styles.editBtn} onPress={handleEdit}>
                <Text style={styles.editBtnText}>＋ 予定を入力する</Text>
              </TouchableOpacity>
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>

      {/* ── 年月日ピッカー ── */}
      <Modal transparent animationType="fade" visible={datePickerVisible} onRequestClose={() => setDatePickerVisible(false)}>
        <TouchableWithoutFeedback onPress={() => setDatePickerVisible(false)}>
          <View style={styles.dpOverlay}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={styles.dpCard}>
                <Text style={styles.dpTitle}>日付を選択</Text>
                <View style={styles.dpRow}>
                  <WheelPicker
                    items={PICKER_YEARS}
                    selectedIndex={PICKER_YEARS.indexOf(pYear) >= 0 ? PICKER_YEARS.indexOf(pYear) : 0}
                    onChange={(i) => setPYear(PICKER_YEARS[i])}
                    formatItem={(v) => `${v}年`}
                    width={100}
                  />
                  <WheelPicker
                    items={PICKER_MONTHS}
                    selectedIndex={pMonth - 1}
                    onChange={(i) => {
                      const m = PICKER_MONTHS[i];
                      setPMonth(m);
                      setPDay((prev) => Math.min(prev, MONTH_DAYS[m - 1]));
                    }}
                    formatItem={(v) => `${v}月`}
                    width={72}
                  />
                  <WheelPicker
                    items={pickerDays}
                    selectedIndex={Math.min(pDay, pickerDays.length) - 1}
                    onChange={(i) => setPDay(pickerDays[i])}
                    formatItem={(v) => `${v}日`}
                    width={72}
                  />
                </View>
                <View style={styles.dpBtns}>
                  <TouchableOpacity style={styles.dpCancelBtn} onPress={() => setDatePickerVisible(false)}>
                    <Text style={styles.dpCancelText}>キャンセル</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.dpConfirmBtn} onPress={confirmDatePicker}>
                    <Text style={styles.dpConfirmText}>決定</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(45,27,105,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    height: SHEET_H,
    backgroundColor: '#FDFAFF',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: '#E0D0F0',
    alignSelf: 'center', marginTop: 10, marginBottom: 8,
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: '#F0E8F8', marginBottom: 16,
  },
  dateText: { fontSize: 14, fontWeight: '800', color: colors.text, textAlign: 'center' },
  arrowBtn: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: '#F5EFF5', alignItems: 'center', justifyContent: 'center',
  },
  arrowText: { fontSize: 22, color: colors.primary, lineHeight: 26 },
  closeBtn: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: '#F0E6F0', alignItems: 'center', justifyContent: 'center',
  },
  closeBtnText: { fontSize: 12, color: colors.textSecondary, fontWeight: '700' },

  content: { flex: 1, gap: 12 },

  stampRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  miniChip: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8,
  },
  miniChipText: { fontSize: 12, fontWeight: '700' },
  mainChip: {
    paddingHorizontal: 16, paddingVertical: 6, borderRadius: 10,
  },
  mainChipText: { fontSize: 15, fontWeight: '900' },

  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  infoIcon: { fontSize: 16 },
  infoText: { fontSize: 15, color: colors.text, fontWeight: '600' },

  specialList: { gap: 6, marginBottom: 8 },
  specialItem: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#F8F4FF', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12,
    borderLeftWidth: 3,
  },
  specialName: { fontSize: 14, fontWeight: '700' },

  imageThumb: { width: 48, height: 48, borderRadius: 12 },
  imageThumbIcon: {
    width: 48, height: 48, borderRadius: 12,
    backgroundColor: '#EDE9FE', alignItems: 'center', justifyContent: 'center',
  },

  notesBox: {
    backgroundColor: '#F5EFF5', borderRadius: 12, padding: 12,
  },
  noteItemRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  notesText: { flex: 1, fontSize: 14, color: colors.text, lineHeight: 20 },

  emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14, color: colors.textLight },

  editBtn: {
    backgroundColor: colors.primary,
    borderRadius: 14, paddingVertical: 14,
    alignItems: 'center',
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
  },
  editBtnText: { fontSize: 16, fontWeight: '800', color: '#FFFFFF' },

  // 年月日ピッカー
  dpOverlay: { flex: 1, backgroundColor: 'rgba(45,27,105,0.4)', justifyContent: 'center', alignItems: 'center' },
  dpCard: { backgroundColor: '#FDFAFF', borderRadius: 24, padding: 24, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 20, elevation: 10, minWidth: 300 },
  dpTitle: { fontSize: 16, fontWeight: '800', color: colors.text, marginBottom: 16 },
  dpRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 },
  dpBtns: { flexDirection: 'row', gap: 10, width: '100%' },
  dpCancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: '#F5EFF5', alignItems: 'center' },
  dpCancelText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  dpConfirmBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center', shadowColor: colors.primary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 3 },
  dpConfirmText: { fontSize: 14, fontWeight: '800', color: '#FFFFFF' },
});
