import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Dimensions,
  TextInput, Image, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { getWeekDays, addDays, formatMonthDay, formatFullDate } from '../../utils/dateUtils';
import { colors } from '../../constants/colors';
import { StampBadge } from '../ui/StampBadge';

const SCREEN_W = Dimensions.get('window').width;
const COL_W = Math.floor((SCREEN_W - 40) / 7);

interface Props {
  currentDate: Date;
  selectedDate: string | null;
  onDayPress: (dateStr: string) => void;
  onWeekChange: (newDate: Date) => void;
}

export function WeeklyView({ currentDate, selectedDate, onDayPress, onWeekChange }: Props) {
  const entries = useCalendarStore((s) => s.entries);
  const specialDates = useCalendarStore((s) => s.specialDates);
  const recurringSchedules = useCalendarStore((s) => s.recurringSchedules);
  const weekStartDay = useCalendarStore((s) => s.weekStartDay);
  const getStamp = useStampStore((s) => s.getStamp);
  const setDiary = useCalendarStore((s) => s.setDiary);
  const setDiaryPhotos = useCalendarStore((s) => s.setDiaryPhotos);

  // 曜日から繰り返し予定を取得
  const getRecurringForDay = (dayOfWeek: number) =>
    recurringSchedules.filter((rs) => rs.daysOfWeek.includes(dayOfWeek));

  // 月日から特別日を取得
  const getSpecialForDate = (month: number, day: number) =>
    specialDates.filter((sd) => sd.month === month && sd.day === day);

  const selectedEntry = selectedDate ? entries[selectedDate] : undefined;
  const [diaryText, setDiaryText] = useState(selectedEntry?.diary ?? '');

  // 選択日の繰り返し予定・特別日
  const selDate = selectedDate ? new Date(selectedDate + 'T00:00:00') : null;
  const selRecurring = selDate ? getRecurringForDay(selDate.getDay()) : [];
  const selSpecials = selDate ? getSpecialForDate(selDate.getMonth() + 1, selDate.getDate()) : [];

  useEffect(() => {
    setDiaryText(selectedDate ? (entries[selectedDate]?.diary ?? '') : '');
  }, [selectedDate]);

  const handlePickPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]?.uri && selectedDate) {
      const current = selectedEntry?.diaryPhotos ?? [];
      setDiaryPhotos(selectedDate, [...current, result.assets[0].uri]);
    }
  };

  const handleRemovePhoto = (index: number) => {
    if (!selectedDate) return;
    Alert.alert('写真を削除', 'この写真を削除しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      { text: '削除', style: 'destructive', onPress: () => {
        const current = selectedEntry?.diaryPhotos ?? [];
        setDiaryPhotos(selectedDate, current.filter((_, i) => i !== index));
      }},
    ]);
  };

  const days = getWeekDays(currentDate, specialDates, weekStartDay);
  const weekStart = days[0];
  const weekEnd = days[6];

  const weekLabel = `${weekStart.date.getMonth() + 1}/${weekStart.date.getDate()} 〜 ${weekEnd.date.getMonth() + 1}/${weekEnd.date.getDate()}`;

  return (
    <View style={styles.container}>
      {/* Week header */}
      <LinearGradient
        colors={['#FFE4F0', '#EDE9FE']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.header}
      >
        <TouchableOpacity
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onWeekChange(addDays(currentDate, -7)); }}
          style={styles.navBtn}
        >
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.weekLabel}>{weekLabel}</Text>
        <TouchableOpacity
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onWeekChange(addDays(currentDate, 7)); }}
          style={styles.navBtn}
        >
          <Ionicons name="chevron-forward" size={22} color={colors.primary} />
        </TouchableOpacity>
      </LinearGradient>

      {/* Day columns + diary */}
      <ScrollView style={styles.scrollArea} showsVerticalScrollIndicator={false}>
        <View style={styles.columns}>
          {days.map((day) => {
            const entry = entries[day.dateString];
            const mainStamp = entry?.mainStampId ? getStamp(entry.mainStampId) : undefined;
            const leftMini = entry?.miniStamps?.left ? getStamp(entry.miniStamps.left) : undefined;
            const rightMini = entry?.miniStamps?.right ? getStamp(entry.miniStamps.right) : undefined;
            const isSelected = selectedDate === day.dateString;
            const dayRecurring = getRecurringForDay(day.date.getDay());
            const daySpecials = getSpecialForDate(day.date.getMonth() + 1, day.date.getDate());

            const DAY_LABELS_SHORT = ['日', '月', '火', '水', '木', '金', '土'];

            return (
              <TouchableOpacity
                key={day.dateString}
                style={[styles.column, isSelected && styles.columnSelected]}
                onPress={() => onDayPress(day.dateString)}
                activeOpacity={0.8}
              >
                {/* Day name */}
                <Text
                  style={[
                    styles.dayName,
                    day.isSunday && styles.sundayText,
                    day.isSaturday && styles.saturdayText,
                  ]}
                >
                  {DAY_LABELS_SHORT[day.date.getDay()]}
                </Text>

                {/* Date number */}
                <View style={[styles.dateCircle, day.isToday && styles.todayCircle]}>
                  <Text style={[styles.dateNum, day.isToday && styles.todayNum]}>
                    {day.date.getDate()}
                  </Text>
                </View>

                {/* Mini stamps */}
                <View style={styles.miniRow}>
                  {leftMini && (
                    <View style={[styles.miniPill, { backgroundColor: leftMini.bgColor }]}>
                      <Text style={[styles.miniText, { color: leftMini.textColor }]}>{leftMini.text}</Text>
                    </View>
                  )}
                  {rightMini && (
                    <View style={[styles.miniPill, { backgroundColor: rightMini.bgColor }]}>
                      <Text style={[styles.miniText, { color: rightMini.textColor }]}>{rightMini.text}</Text>
                    </View>
                  )}
                </View>

                {/* Main stamp（エントリー or 繰り返し予定） */}
                {mainStamp ? (
                  <View style={[styles.mainBand, { backgroundColor: mainStamp.bgColor }]}>
                    <Text style={[styles.mainBandText, { color: mainStamp.textColor }]}>{mainStamp.text}</Text>
                  </View>
                ) : dayRecurring.length > 0 ? (
                  <View style={[styles.mainBand, { backgroundColor: getStamp(dayRecurring[0].stampId)?.bgColor ?? colors.primaryLight }]}>
                    <Text style={[styles.mainBandText, { color: getStamp(dayRecurring[0].stampId)?.textColor ?? '#FFFFFF' }]} numberOfLines={1}>
                      {getStamp(dayRecurring[0].stampId)?.text ?? ''}
                    </Text>
                  </View>
                ) : (
                  <View style={styles.mainBandEmpty} />
                )}

                {/* 繰り返し予定（2件目以降）のアイコン */}
                {dayRecurring.slice(1).map((rs) => {
                  const s = getStamp(rs.stampId);
                  if (!s) return null;
                  return (
                    <View key={rs.id} style={[styles.recurringChip, { backgroundColor: s.bgColor }]}>
                      <Text style={[styles.recurringChipText, { color: s.textColor }]} numberOfLines={1}>{s.text}</Text>
                    </View>
                  );
                })}

                {/* 特別日アイコン */}
                {daySpecials.map((sd) => (
                  <View key={sd.id} style={styles.specialIconRow}>
                    <Ionicons name={(sd.emoji as any) || 'gift-outline'} size={10} color={sd.color} />
                  </View>
                ))}

                {/* Notes indicator */}
                {entry?.notes && (
                  <Ionicons name="document-text" size={10} color={colors.textLight} style={{ marginTop: 2 }} />
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── 日記・写真セクション ── */}
        {selectedDate && (
          <View style={styles.diarySection}>
            <Text style={styles.diaryDateLabel}>{formatFullDate(selectedDate)}</Text>

            {/* 繰り返し予定・特別日チップ */}
            {(selRecurring.length > 0 || selSpecials.length > 0) && (
              <View style={styles.scheduleChips}>
                {selRecurring.map((rs) => {
                  const s = getStamp(rs.stampId);
                  if (!s) return null;
                  return (
                    <View key={rs.id} style={[styles.scheduleChip, { backgroundColor: s.bgColor }]}>
                      <Text style={[styles.scheduleChipText, { color: s.textColor }]}>{s.text}</Text>
                    </View>
                  );
                })}
                {selSpecials.map((sd) => (
                  <View key={sd.id} style={[styles.scheduleChip, { backgroundColor: sd.color + '22' }]}>
                    <Ionicons name={(sd.emoji as any) || 'gift-outline'} size={12} color={sd.color} />
                    <Text style={[styles.scheduleChipText, { color: sd.color }]}>{sd.name}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* 日記入力 */}
            <TextInput
              style={styles.diaryInput}
              value={diaryText}
              onChangeText={setDiaryText}
              onBlur={() => setDiary(selectedDate, diaryText)}
              placeholder="今日の日記を書く…"
              placeholderTextColor={colors.textLight}
              multiline
              textAlignVertical="top"
            />

            {/* 写真 */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoRow}>
              {(selectedEntry?.diaryPhotos ?? []).map((uri, i) => (
                <View key={i} style={styles.photoSlot}>
                  <Image source={{ uri }} style={styles.photoImg} />
                  <TouchableOpacity style={styles.photoDelete} onPress={() => handleRemovePhoto(i)}>
                    <Ionicons name="close-circle" size={20} color="#EF4444" />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity
                style={styles.photoSlotEmpty}
                onPress={() => { Haptics.selectionAsync(); handlePickPhoto(); }}
              >
                <Ionicons name="camera-outline" size={24} color={colors.primaryLight} />
                <Text style={styles.photoAddLabel}>追加</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        )}
        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  navBtn: {
    width: 36, height: 36, alignItems: 'center', justifyContent: 'center',
    borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.6)',
  },
  weekLabel: { fontSize: 15, fontWeight: '700', color: colors.text },
  scrollArea: { flex: 1 },
  columns: {
    flexDirection: 'row',
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  column: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 5,
    paddingBottom: 4,
    marginHorizontal: 2,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
  },
  columnSelected: {
    backgroundColor: '#FFE4F0',
    borderWidth: 2,
    borderColor: colors.primary,
  },
  dayName: {
    fontSize: 10, fontWeight: '700', color: colors.textSecondary, marginBottom: 2,
  },
  sundayText: { color: colors.sunday },
  saturdayText: { color: colors.saturday },
  dateCircle: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', marginBottom: 3,
  },
  todayCircle: { backgroundColor: colors.primary },
  dateNum: { fontSize: 12, fontWeight: '700', color: colors.text },
  todayNum: { color: '#FFFFFF' },
  miniRow: {
    width: '100%', alignItems: 'center', marginBottom: 2, gap: 1,
  },
  miniPill: {
    width: '88%', borderRadius: 3, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 1, marginBottom: 1,
  },
  miniText: { fontSize: 8, fontWeight: '800' },
  mainBand: {
    width: '88%', borderRadius: 4, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 3, marginTop: 1,
  },
  mainBandEmpty: { width: '88%', height: 18, marginTop: 1 },
  mainBandText: { fontSize: 11, fontWeight: '800' },
  specialDot: { width: 5, height: 5, borderRadius: 3, marginTop: 2 },
  specialIconRow: { marginTop: 2, alignItems: 'center' },
  recurringChip: {
    width: '88%', borderRadius: 3, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 1, marginTop: 1,
  },
  recurringChipText: { fontSize: 8, fontWeight: '800' },
  scheduleChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  scheduleChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4,
  },
  scheduleChipText: { fontSize: 12, fontWeight: '700' },

  // 日記・写真
  diarySection: {
    marginHorizontal: 8,
    marginTop: 4,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 14,
    shadowColor: '#A78BFA',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  diaryDateLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.primary,
    marginBottom: 8,
  },
  diaryInput: {
    backgroundColor: '#F8F4FC',
    borderRadius: 10,
    padding: 10,
    fontSize: 14,
    color: colors.text,
    minHeight: 160,
    lineHeight: 20,
  },
  photoRow: {
    marginTop: 10,
  },
  photoSlot: {
    width: 80,
    height: 80,
    borderRadius: 12,
    overflow: 'visible',
    position: 'relative',
    marginRight: 10,
  },
  photoImg: {
    width: 80,
    height: 80,
    borderRadius: 12,
  },
  photoDelete: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
  },
  photoSlotEmpty: {
    width: 80,
    height: 80,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.primaryLight,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: '#FAF7FF',
  },
  photoAddLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.primaryLight,
  },
});
