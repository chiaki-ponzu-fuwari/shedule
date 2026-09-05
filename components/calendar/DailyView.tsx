import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  TextInput, Modal, TouchableWithoutFeedback, Alert, Switch,
  Linking, LayoutChangeEvent, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Haptics } from '../../utils/haptics';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { addDays, formatDate, formatFullDate } from '../../utils/dateUtils';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import { NoteItem, TimeSlot } from '../../types';
import { WheelPicker } from '../ui/WheelPicker';
import { TimelineHourLabel } from '../ui/TimelineHourLabel';
import { HorizontalDateStrip } from '../ui/HorizontalDateStrip';
import { requestNotificationPermission, scheduleNotification, cancelNotification } from '../../utils/notifications';

/** 初回レイアウト前・極小画面用のフォールバック（px / 1時間） */
const DEFAULT_HOUR_H = 22;
const MIN_HOUR_H = 16;
/** 24:00 ラベル行（短くして 0〜23 時の行をできるだけ広く） */
const END_HOUR_ROW_RATIO = 0.07;
const END_HOUR_ROW_MIN = 12;
const START_HOUR = 0;
const END_HOUR = 24;
const LABEL_W = 58;

const HOUR_LABEL_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

const SLOT_COLORS = [
  '#FF6B9D', '#3B82F6', '#60A5FA', '#34D399',
  '#FBBF24', '#F97316', '#FB7185', '#818CF8',
];
const NOTE_ITEM_DEFAULT_COLOR = '#60A5FA';
const GRID_TOP_PAD = 4;
const GRID_BOTTOM_PAD = 2;

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function fromMin(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// ── 時間ピッカー（ホイール選択式）──────────────────────────
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

function TimePicker({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [h, m] = value.split(':').map(Number);
  const mIndex = MINUTES.indexOf(m) >= 0 ? MINUTES.indexOf(m) : 0;
  return (
    <View style={tp.wrap}>
      <Text style={tp.label}>{label}</Text>
      <View style={tp.row}>
        <WheelPicker
          items={HOURS}
          selectedIndex={h}
          onChange={(i) => onChange(fromMin(HOURS[i] * 60 + m))}
          formatItem={(v) => String(v).padStart(2, '0')}
        />
        <Text style={tp.colon}>:</Text>
        <WheelPicker
          items={MINUTES}
          selectedIndex={mIndex}
          onChange={(i) => onChange(fromMin(h * 60 + MINUTES[i]))}
          formatItem={(v) => String(v).padStart(2, '0')}
        />
      </View>
    </View>
  );
}

const tp = StyleSheet.create({
  wrap: { gap: 6 },
  label: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  colon: { fontSize: 24, fontWeight: '800', color: colors.text },
});

// ── メイン ────────────────────────────────────────────────
interface Props {
  currentDate: string;
  onDayChange: (d: string) => void;
  onStampPress?: () => void;
}

export function DailyView({ currentDate, onDayChange, onStampPress }: Props) {
  const { t, locale } = useTranslation();
  const entry = useCalendarStore((s) => s.getEntry(currentDate));
  const addTimeSlot = useCalendarStore((s) => s.addTimeSlot);
  const updateTimeSlot = useCalendarStore((s) => s.updateTimeSlot);
  const removeTimeSlot = useCalendarStore((s) => s.removeTimeSlot);
  const setNoteItems = useCalendarStore((s) => s.setNoteItems);
  const setDailyGoal = useCalendarStore((s) => s.setDailyGoal);
  const specialDates = useCalendarStore((s) => s.specialDates);
  const getStamp = useStampStore((s) => s.getStamp);

  const [goalText, setGoalText] = useState(entry?.dailyGoal ?? '');

  // デイリー（タイムスケジュール）ではメイン/ミニ表記は表示しない

  const curDate = new Date(currentDate + 'T00:00:00');
  const timeSlots: TimeSlot[] = entry?.timeSlots ?? [];
  // 月カレンダーの予定（時間あり・対応するTimeSlotがないもの）をDailyViewに表示
  const timeSlotIds = new Set(timeSlots.map(s => s.id));
  const noteItemEvents = (entry?.noteItems ?? []).filter(
    (n) => n.time && !(n.fromTimeSlotId && timeSlotIds.has(n.fromTimeSlotId))
  );
  const special = specialDates.find(s => s.month === curDate.getMonth() + 1 && s.day === curDate.getDate());

  useEffect(() => {
    setGoalText(entry?.dailyGoal ?? '');
  }, [currentDate]);

  const [modalVisible, setModalVisible] = useState(false);
  const [editId, setEditId] = useState<string | undefined>(undefined);
  const [editNoteItemId, setEditNoteItemId] = useState<string | undefined>(undefined);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime]     = useState('10:00');
  const [title, setTitle]         = useState('');
  const [url, setUrl]             = useState('');
  const [slotColor, setSlotColor] = useState(SLOT_COLORS[0]);
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [editNotifId, setEditNotifId] = useState<string | undefined>(undefined);
  const [reflectToMonthly, setReflectToMonthly] = useState(false);

  const openAdd = (hour = 9) => {
    const h = String(hour).padStart(2,'0');
    const h2 = String(Math.min(hour + 1, 23)).padStart(2,'0');
    setEditId(undefined);
    setEditNoteItemId(undefined);
    setStartTime(`${h}:00`);
    setEndTime(`${h2}:00`);
    setTitle('');
    setUrl('');
    setSlotColor(SLOT_COLORS[timeSlots.length % SLOT_COLORS.length]);
    setNotifEnabled(false);
    setEditNotifId(undefined);
    setReflectToMonthly(false);
    setModalVisible(true);
  };

  const openEdit = (slot: TimeSlot) => {
    setEditId(slot.id);
    setEditNoteItemId(undefined);
    setStartTime(slot.startTime);
    setEndTime(slot.endTime);
    setTitle(slot.title);
    setUrl(slot.url ?? '');
    setSlotColor(slot.color);
    setNotifEnabled(slot.notificationEnabled ?? false);
    setEditNotifId(slot.notificationId);
    setReflectToMonthly(slot.reflectToMonthly ?? false);
    setModalVisible(true);
  };

  const openEditNoteItem = (item: NoteItem) => {
    setEditId(undefined);
    setEditNoteItemId(item.id);
    setStartTime(item.time ?? '09:00');
    setEndTime(item.endTime ?? '10:00');
    setTitle(item.text);
    setUrl(item.url ?? '');
    setSlotColor(item.color ?? NOTE_ITEM_DEFAULT_COLOR);
    setNotifEnabled(item.notificationEnabled ?? false);
    setEditNotifId(item.notificationId);
    setReflectToMonthly(false);
    setModalVisible(true);
  };

  const handleSave = async () => {
    if (!title.trim()) return;
    let notifId = editNotifId;
    const rangeSep = locale === 'en' ? '–' : '〜';
    const timeRangeBody = `${startTime}${rangeSep}${endTime}`;

    if (editNoteItemId) {
      // NoteItemの編集
      if (notifEnabled) {
        const granted = await requestNotificationPermission();
        if (granted) {
          if (notifId) await cancelNotification(notifId);
          const result = await scheduleNotification(
            currentDate, startTime, t('daily.notif5min', { title }), timeRangeBody
          );
          notifId = result.id ?? undefined;
        }
      } else if (notifId) {
        await cancelNotification(notifId);
        notifId = undefined;
      }
      const currentItems = entry?.noteItems ?? [];
      const updatedItem = currentItems.find((n) => n.id === editNoteItemId);
      if (updatedItem) {
        const updated: NoteItem = {
          ...updatedItem,
          text: title,
          time: startTime,
          endTime,
          url: url.trim() ? url.trim() : undefined,
          color: slotColor,
          notificationEnabled: notifEnabled,
          notificationId: notifId,
        };
        const newItems = currentItems.map((n) => n.id === editNoteItemId ? updated : n);
        setNoteItems(currentDate, newItems);
        // TimeSlotへ同期
        if (updated.fromTimeSlotId) {
          updateTimeSlot(currentDate, updated.fromTimeSlotId, {
            title: updated.text,
            startTime: updated.time ?? '',
            endTime: updated.endTime ?? '',
            url: updated.url,
            notificationEnabled: updated.notificationEnabled ?? false,
            notificationId: updated.notificationId,
          });
        }
      }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setModalVisible(false);
      return;
    }

    // TimeSlotの通知は「タイムスケジュール上でONなら常に5分前通知」
    if (notifEnabled) {
      const granted = await requestNotificationPermission();
      if (granted) {
        if (notifId) await cancelNotification(notifId);
        const result = await scheduleNotification(
          currentDate,
          startTime,
          t('daily.notif5min', { title }),
          timeRangeBody
        );
        notifId = result.id ?? undefined;
      }
    } else if (notifId) {
      await cancelNotification(notifId);
      notifId = undefined;
    }

    const slotData = {
      startTime, endTime, title, color: slotColor,
      url: url.trim() ? url.trim() : undefined,
      notificationEnabled: notifEnabled,
      notificationId: notifId,
      reflectToMonthly,
    };

    if (editId) {
      updateTimeSlot(currentDate, editId, slotData);
    } else {
      addTimeSlot(currentDate, slotData);
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setModalVisible(false);
  };

  const handleDelete = () => {
    if (!editId && !editNoteItemId) return;
    Alert.alert(t('daily.deleteEventTitle'), t('daily.deleteEventMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.delete'), style: 'destructive', onPress: async () => {
        if (editNotifId) await cancelNotification(editNotifId);
        if (editNoteItemId) {
          const currentItems = entry?.noteItems ?? [];
          setNoteItems(currentDate, currentItems.filter((n) => n.id !== editNoteItemId));
        } else if (editId) {
          removeTimeSlot(currentDate, editId);
        }
        setModalVisible(false);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }},
    ]);
  };

  const openUrl = (raw?: string) => {
    if (!raw) return;
    const normalized = raw.startsWith('http') ? raw : `https://${raw}`;
    Linking.openURL(normalized).catch(() => {});
  };

  const [timelineViewportH, setTimelineViewportH] = useState(0);
  const onTimelineViewportLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) setTimelineViewportH(h);
  };
  const innerTimelineH = Math.max(0, timelineViewportH);
  const timelineInner =
    innerTimelineH > 0 ? innerTimelineH - GRID_TOP_PAD - GRID_BOTTOM_PAD : 0;
  const endHourRowH =
    innerTimelineH > 0
      ? Math.max(END_HOUR_ROW_MIN, timelineInner * END_HOUR_ROW_RATIO)
      : DEFAULT_HOUR_H * 0.25;
  const hourRowH =
    innerTimelineH > 0
      ? Math.max(MIN_HOUR_H, (timelineInner - endHourRowH) / 24)
      : DEFAULT_HOUR_H;

  // グリッド用時間配列
  const hours = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => i + START_HOUR);

  return (
    <View style={styles.container}>
      {/* ── ヘッダー ── */}
      <LinearGradient colors={['#DBEAFE','#EFF6FF']} start={{x:0,y:0}} end={{x:1,y:0}} style={styles.header}>
        <View style={styles.dateRow}>
          <TouchableOpacity style={styles.navBtn} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onDayChange(formatDate(addDays(curDate,-1))); }}>
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
          </TouchableOpacity>
          <Text style={styles.dateLabel}>{formatFullDate(currentDate, locale)}</Text>
          <TouchableOpacity style={styles.navBtn} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onDayChange(formatDate(addDays(curDate,1))); }}>
            <Ionicons name="chevron-forward" size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>
        <HorizontalDateStrip selectedDate={currentDate} onDateChange={onDayChange} />
      </LinearGradient>

      {/* ── 本日の目標 ── */}
      <View style={styles.goalSection}>
        <TextInput
          style={styles.goalInput}
          value={goalText}
          onChangeText={setGoalText}
          onBlur={() => setDailyGoal(currentDate, goalText)}
          placeholder={t('daily.goalPlaceholder')}
          placeholderTextColor={colors.textLight}
          multiline
        />
      </View>

      {/* ── タイムライン（flex 内の高さを 24h で均等割） ── */}
      <View style={styles.timelineViewport} onLayout={onTimelineViewportLayout}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={
            innerTimelineH > 0
              ? { minHeight: innerTimelineH }
              : undefined
          }
          showsVerticalScrollIndicator={false}
        >
          {/* 通常フローで高さを確定 → イベントを絶対オーバーレイ */}
          <View style={styles.gridContainer}>
            {/* 0:00の前に少し余白 */}
            <View style={{ height: GRID_TOP_PAD }} />

            {/* グリッド行（通常フロー） */}
            {hours.map((hour) => (
              <TouchableOpacity
                key={hour}
                style={[styles.hourRow, { height: hourRowH }]}
                onPress={() => openAdd(hour)}
                activeOpacity={0.3}
              >
                <TimelineHourLabel hour={hour} style={styles.hourLabel} />
                <View style={styles.hourLine} />
              </TouchableOpacity>
            ))}
            {/* 24:00 終端ライン */}
            <View style={[styles.hourRowEnd, { height: endHourRowH }]}>
              <TimelineHourLabel hour={24} style={styles.hourLabel} />
              <View style={styles.hourLine} />
            </View>
            {/* 24:00の後にも少し余白 */}
            <View style={{ height: GRID_BOTTOM_PAD }} />

            {/* イベントブロック（絶対オーバーレイ） */}
            {timeSlots.map((slot) => {
              const startM = toMin(slot.startTime) - START_HOUR * 60;
              const endM = toMin(slot.endTime) - START_HOUR * 60;
              const top = GRID_TOP_PAD + (startM / 60) * hourRowH;
              const height = Math.max(
                ((endM - startM) / 60) * hourRowH,
                Math.max(24, hourRowH * 0.28)
              );
              return (
                <TouchableOpacity
                  key={slot.id}
                  style={[styles.eventBlock, { top, height, backgroundColor: slot.color }]}
                  onPress={() => { Haptics.selectionAsync(); openEdit(slot); }}
                  onLongPress={() => slot.url ? openUrl(slot.url) : undefined}
                  activeOpacity={0.85}
                >
                  <Text style={styles.eventTitle} numberOfLines={1}>{slot.title}</Text>
                  {height >= hourRowH * 0.55 && (
                    <Text style={styles.eventTime}>{slot.startTime}{locale === 'en' ? '–' : '〜'}{slot.endTime}</Text>
                  )}
                </TouchableOpacity>
              );
            })}

          {/* 月カレ予定（タップで編集可）*/}
          {noteItemEvents.map((item) => {
            const startM = toMin(item.time!) - START_HOUR * 60;
            const endM = item.endTime ? toMin(item.endTime) - START_HOUR * 60 : startM + 30;
            const top = GRID_TOP_PAD + (startM / 60) * hourRowH;
            const height = Math.max(
              ((endM - startM) / 60) * hourRowH,
              Math.max(20, hourRowH * 0.24)
            );
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.noteEventBlock, { top, height, backgroundColor: item.color ?? NOTE_ITEM_DEFAULT_COLOR }]}
                onPress={() => { Haptics.selectionAsync(); openEditNoteItem(item); }}
                onLongPress={() => item.url ? openUrl(item.url) : undefined}
                activeOpacity={0.85}
              >
                <Text style={styles.noteEventTitle} numberOfLines={1}>{item.text}</Text>
                {height >= hourRowH * 0.5 && (
                  <Text style={styles.noteEventTime}>
                    {item.time}{item.endTime ? `${locale === 'en' ? '–' : '〜'}${item.endTime}` : ''}
                  </Text>
                )}
              </TouchableOpacity>
            );
          })}
          </View>
        </ScrollView>
      </View>

      {/* ＋ボタン（月/週と同じ右下配置） */}
      <TouchableOpacity style={styles.addFab} onPress={() => openAdd()} activeOpacity={0.9}>
        <Ionicons name="add" size={24} color="#FFFFFF" />
      </TouchableOpacity>

      {/* ── 予定追加・編集モーダル ── */}
      <Modal transparent visible={modalVisible} animationType="fade" onRequestClose={() => setModalVisible(false)}>
        <TouchableWithoutFeedback onPress={() => setModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={styles.modalCard}>
                <Text style={styles.modalTitle}>{(editId || editNoteItemId) ? t('daily.editEvent') : t('daily.addEvent')}</Text>

                <TextInput
                  style={styles.modalInput}
                  value={title}
                  onChangeText={setTitle}
                  placeholder={t('daily.titlePlaceholder')}
                  placeholderTextColor={colors.textLight}
                  autoFocus
                />

                <TextInput
                  style={styles.modalInput}
                  value={url}
                  onChangeText={setUrl}
                  placeholder={t('daily.urlPlaceholder')}
                  placeholderTextColor={colors.textLight}
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                <TimePicker label={t('daily.startTime')} value={startTime} onChange={setStartTime} />
                <TimePicker label={t('daily.endTime')} value={endTime}   onChange={setEndTime} />

                {/* マンスリーに反映（NoteItem編集時は非表示） */}
                {!editNoteItemId && (
                  <View style={styles.notifRow}>
                    <Ionicons name="calendar-outline" size={16} color={colors.primary} />
                    <Text style={styles.notifLabel}>{t('daily.reflectMonthly')}</Text>
                    <Switch
                      value={reflectToMonthly}
                      onValueChange={(v) => { setReflectToMonthly(v); if (!v) setNotifEnabled(false); }}
                      trackColor={{ false: '#BFDBFE', true: colors.primaryLight }}
                      thumbColor={reflectToMonthly ? colors.primary : '#FFFFFF'}
                      style={{ marginLeft: 'auto' }}
                    />
                  </View>
                )}

                {/* 通知（タイムスケジュールでも常に利用可能） */}
                <View style={styles.notifRow}>
                  <Ionicons name="notifications-outline" size={16} color={colors.primary} />
                  <Text style={styles.notifLabel}>{t('daily.notify5min')}</Text>
                  <Switch
                    value={notifEnabled}
                    onValueChange={setNotifEnabled}
                    trackColor={{ false: '#BFDBFE', true: colors.primaryLight }}
                    thumbColor={notifEnabled ? colors.primary : '#FFFFFF'}
                    style={{ marginLeft: 'auto' }}
                  />
                </View>

                {/* カラー（常に表示） */}
                <View style={styles.colorRow}>
                  {SLOT_COLORS.map((c) => (
                    <TouchableOpacity
                      key={c}
                      style={[styles.colorDot, { backgroundColor: c }, slotColor === c && styles.colorDotOn]}
                      onPress={() => { Haptics.selectionAsync(); setSlotColor(c); }}
                    />
                  ))}
                </View>

                <View style={styles.modalBtns}>
                  {(editId || editNoteItemId) && (
                    <TouchableOpacity style={styles.delBtn} onPress={handleDelete}>
                      <Text style={styles.delBtnText}>{t('common.delete')}</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity style={styles.cancelBtn} onPress={() => setModalVisible(false)}>
                    <Text style={styles.cancelBtnText}>{t('common.cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
                    <Text style={styles.saveBtnText}>{t('daily.save')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  // ヘッダー
  // スタンプボタンを削除した分、縦幅をコンパクトに
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, gap: 4 },
  dateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.6)', alignItems: 'center', justifyContent: 'center' },
  dateLabel: { fontSize: 15, fontWeight: '800', color: colors.text, flex: 1, textAlign: 'center' },

  addFab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },

  // タイムライン
  timelineViewport: { flex: 1 },
  scroll: { flex: 1 },
  gridContainer: { position: 'relative' },

  hourRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderTopWidth: 0.5,
    borderTopColor: '#D4C8E8',
  },
  hourRowEnd: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderTopWidth: 0.5,
    borderTopColor: '#D4C8E8',
  },
  hourLabel: {
    width: LABEL_W,
    fontSize: 13,
    lineHeight: 16,
    color: colors.textSecondary,
    fontWeight: '700',
    fontFamily: HOUR_LABEL_FONT,
    ...(Platform.OS === 'ios' ? { fontVariant: ['tabular-nums' as const] } : {}),
    paddingLeft: 6,
    marginTop: -1,
  },
  hourLine: { flex: 1, borderLeftWidth: 0.5, borderLeftColor: '#E5DCF0', height: '100%' },

  // イベント（絶対）
  eventBlock: {
    position: 'absolute',
    left: LABEL_W + 4,
    right: 6,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    zIndex: 10,
    shadowColor: '#000', shadowOffset:{width:0,height:1}, shadowOpacity:0.15, shadowRadius:3, elevation:2,
  },
  eventTitle: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
  eventTime:  { fontSize: 12, color: 'rgba(255,255,255,0.9)', marginTop: 1 },

  // モーダル
  notifRow: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F8F4FC', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  notifLabel: { fontSize: 14, fontWeight: '600', color: colors.text },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)', justifyContent: 'center', paddingHorizontal: 20 },
  modalCard: { backgroundColor: '#FDFAFF', borderRadius: 24, padding: 20, gap: 14, shadowColor: '#000', shadowOffset:{width:0,height:8}, shadowOpacity:0.15, shadowRadius:20, elevation:10 },
  modalTitle: { fontSize: 16, fontWeight: '800', color: colors.text, textAlign: 'center' },
  modalInput: { backgroundColor: '#F5EFF5', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.text },
  colorRow: { flexDirection: 'row', gap: 8, justifyContent: 'center' },
  colorDot: { width: 28, height: 28, borderRadius: 14 },
  colorDotOn: { borderWidth: 3, borderColor: colors.text },
  modalBtns: { flexDirection: 'row', gap: 8 },
  delBtn: { flex: 1, paddingVertical: 11, borderRadius: 12, backgroundColor: '#FFF0F0', alignItems: 'center' },
  delBtnText: { fontSize: 14, fontWeight: '700', color: '#EF4444' },
  cancelBtn: { paddingHorizontal: 14, paddingVertical: 11, borderRadius: 12, backgroundColor: '#F5EFF5' },
  cancelBtnText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  saveBtn: { flex: 1, paddingVertical: 11, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center' },
  saveBtnText: { fontSize: 14, fontWeight: '800', color: '#FFFFFF' },

  // 月カレ予定ブロック（絶対配置・塗りつぶし）
  noteEventBlock: {
    position: 'absolute',
    left: LABEL_W + 4,
    right: 6,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    zIndex: 9,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 3, elevation: 2,
  },
  noteEventTitle: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
  noteEventTime: { fontSize: 12, color: 'rgba(255,255,255,0.9)', marginTop: 1 },

  // 本日の目標
  goalSection: {
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 4,
  },
  goalInput: {
    backgroundColor: '#FFFDE7',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 18,
    color: colors.text,
    minHeight: 44,
    lineHeight: 24,
  },
});
