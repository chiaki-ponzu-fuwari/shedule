import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  TextInput, Modal, TouchableWithoutFeedback, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { addDays, formatDate, formatFullDate } from '../../utils/dateUtils';
import { colors } from '../../constants/colors';
import { TimeSlot } from '../../types';
import { WheelPicker } from '../ui/WheelPicker';

const HOUR_H = 21;
const START_HOUR = 0;
const END_HOUR = 24;
const LABEL_W = 52;

const SLOT_COLORS = [
  '#FF6B9D', '#A78BFA', '#60A5FA', '#34D399',
  '#FBBF24', '#F97316', '#FB7185', '#818CF8',
];

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
  onStampPress: () => void;
}

export function DailyView({ currentDate, onDayChange, onStampPress }: Props) {
  const entry = useCalendarStore((s) => s.getEntry(currentDate));
  const addTimeSlot = useCalendarStore((s) => s.addTimeSlot);
  const updateTimeSlot = useCalendarStore((s) => s.updateTimeSlot);
  const removeTimeSlot = useCalendarStore((s) => s.removeTimeSlot);
  const specialDates = useCalendarStore((s) => s.specialDates);
  const getStamp = useStampStore((s) => s.getStamp);

  const mainStamp = entry?.mainStampId ? getStamp(entry.mainStampId) : undefined;
  const leftMini  = entry?.miniStamps?.left  ? getStamp(entry.miniStamps.left)  : undefined;
  const rightMini = entry?.miniStamps?.right ? getStamp(entry.miniStamps.right) : undefined;

  const curDate = new Date(currentDate + 'T00:00:00');
  const timeSlots: TimeSlot[] = entry?.timeSlots ?? [];
  const special = specialDates.find(s => s.month === curDate.getMonth() + 1 && s.day === curDate.getDate());

  const [modalVisible, setModalVisible] = useState(false);
  const [editId, setEditId] = useState<string | undefined>(undefined);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime]     = useState('10:00');
  const [title, setTitle]         = useState('');
  const [slotColor, setSlotColor] = useState(SLOT_COLORS[0]);

  const openAdd = (hour = 9) => {
    const h = String(hour).padStart(2,'0');
    const h2 = String(Math.min(hour + 1, 23)).padStart(2,'0');
    setEditId(undefined);
    setStartTime(`${h}:00`);
    setEndTime(`${h2}:00`);
    setTitle('');
    setSlotColor(SLOT_COLORS[timeSlots.length % SLOT_COLORS.length]);
    setModalVisible(true);
  };

  const openEdit = (slot: TimeSlot) => {
    setEditId(slot.id);
    setStartTime(slot.startTime);
    setEndTime(slot.endTime);
    setTitle(slot.title);
    setSlotColor(slot.color);
    setModalVisible(true);
  };

  const handleSave = () => {
    if (!title.trim()) return;
    if (editId) {
      updateTimeSlot(currentDate, editId, { startTime, endTime, title, color: slotColor });
    } else {
      addTimeSlot(currentDate, { startTime, endTime, title, color: slotColor });
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setModalVisible(false);
  };

  const handleDelete = () => {
    if (!editId) return;
    Alert.alert('削除', 'この予定を削除しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      { text: '削除', style: 'destructive', onPress: () => {
        removeTimeSlot(currentDate, editId);
        setModalVisible(false);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }},
    ]);
  };

  // グリッド用時間配列
  const hours = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => i + START_HOUR);

  return (
    <View style={styles.container}>
      {/* ── ヘッダー ── */}
      <LinearGradient colors={['#FFE4F0','#EDE9FE']} start={{x:0,y:0}} end={{x:1,y:0}} style={styles.header}>
        <View style={styles.dateRow}>
          <TouchableOpacity style={styles.navBtn} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onDayChange(formatDate(addDays(curDate,-1))); }}>
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
          </TouchableOpacity>
          <Text style={styles.dateLabel}>{formatFullDate(currentDate)}</Text>
          <TouchableOpacity style={styles.navBtn} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onDayChange(formatDate(addDays(curDate,1))); }}>
            <Ionicons name="chevron-forward" size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>

        <View style={styles.headerBottom}>
          <TouchableOpacity style={styles.stampRow} onPress={onStampPress} activeOpacity={0.8}>
            {mainStamp ? (
              <View style={[styles.mainBadge,{backgroundColor:mainStamp.bgColor}]}>
                <Text style={[styles.mainBadgeText,{color:mainStamp.textColor}]}>{mainStamp.text}</Text>
              </View>
            ) : (
              <View style={styles.badgeEmpty}><Text style={styles.badgeEmptyText}>メイン＋</Text></View>
            )}
            <View style={styles.miniBadges}>
              {leftMini ? (
                <View style={[styles.miniBadge,{backgroundColor:leftMini.bgColor}]}>
                  <Text style={[styles.miniBadgeText,{color:leftMini.textColor}]}>{leftMini.text}</Text>
                </View>
              ) : (
                <View style={styles.badgeEmpty}><Text style={styles.badgeEmptyText}>左＋</Text></View>
              )}
              {rightMini ? (
                <View style={[styles.miniBadge,{backgroundColor:rightMini.bgColor}]}>
                  <Text style={[styles.miniBadgeText,{color:rightMini.textColor}]}>{rightMini.text}</Text>
                </View>
              ) : (
                <View style={styles.badgeEmpty}><Text style={styles.badgeEmptyText}>右＋</Text></View>
              )}
            </View>
            {special && (
              <View style={styles.specialLabelRow}>
                <Ionicons name={(special.emoji as any) || 'gift-outline'} size={13} color={special.color} />
                <Text style={[styles.specialLabel, { color: special.color }]}>{special.name}</Text>
              </View>
            )}
          </TouchableOpacity>

          {/* ＋ボタン */}
          <TouchableOpacity style={styles.addFab} onPress={() => openAdd()}>
            <Ionicons name="add" size={22} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </LinearGradient>

      {/* ── タイムライン ── */}
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* 通常フローで高さを確定 → イベントを絶対オーバーレイ */}
        <View style={styles.gridContainer}>

          {/* グリッド行（通常フロー） */}
          {hours.map((hour) => (
            <TouchableOpacity
              key={hour}
              style={styles.hourRow}
              onPress={() => openAdd(hour)}
              activeOpacity={0.3}
            >
              <Text style={styles.hourLabel}>{String(hour).padStart(2,'0')}:00</Text>
              <View style={styles.hourLine} />
            </TouchableOpacity>
          ))}
          {/* 24:00 終端ライン */}
          <View style={styles.hourRowEnd}>
            <Text style={styles.hourLabel}>24:00</Text>
            <View style={styles.hourLine} />
          </View>

          {/* イベントブロック（絶対オーバーレイ） */}
          {timeSlots.map((slot) => {
            const startM = toMin(slot.startTime) - START_HOUR * 60;
            const endM   = toMin(slot.endTime)   - START_HOUR * 60;
            const top    = (startM / 60) * HOUR_H;
            const height = Math.max(((endM - startM) / 60) * HOUR_H, 26);
            return (
              <TouchableOpacity
                key={slot.id}
                style={[styles.eventBlock, { top, height, backgroundColor: slot.color }]}
                onPress={() => { Haptics.selectionAsync(); openEdit(slot); }}
                activeOpacity={0.85}
              >
                <Text style={styles.eventTitle} numberOfLines={1}>{slot.title}</Text>
                {height >= 36 && (
                  <Text style={styles.eventTime}>{slot.startTime}〜{slot.endTime}</Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
        <View style={{height:60}} />
      </ScrollView>

      {/* ── 予定追加・編集モーダル ── */}
      <Modal transparent visible={modalVisible} animationType="fade" onRequestClose={() => setModalVisible(false)}>
        <TouchableWithoutFeedback onPress={() => setModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={styles.modalCard}>
                <Text style={styles.modalTitle}>{editId ? '予定を編集' : '予定を追加'}</Text>

                <TextInput
                  style={styles.modalInput}
                  value={title}
                  onChangeText={setTitle}
                  placeholder="タイトル（例: 会議・ランチ）"
                  placeholderTextColor={colors.textLight}
                  autoFocus
                />

                <TimePicker label="開始時間" value={startTime} onChange={setStartTime} />
                <TimePicker label="終了時間" value={endTime}   onChange={setEndTime} />

                {/* カラー */}
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
                  {editId && (
                    <TouchableOpacity style={styles.delBtn} onPress={handleDelete}>
                      <Text style={styles.delBtnText}>削除</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity style={styles.cancelBtn} onPress={() => setModalVisible(false)}>
                    <Text style={styles.cancelBtnText}>キャンセル</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
                    <Text style={styles.saveBtnText}>保存</Text>
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
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, gap: 8 },
  dateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.6)', alignItems: 'center', justifyContent: 'center' },
  dateLabel: { fontSize: 15, fontWeight: '800', color: colors.text, flex: 1, textAlign: 'center' },
  headerBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stampRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, flexWrap: 'wrap' },
  mainBadge: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 9 },
  mainBadgeText: { fontSize: 13, fontWeight: '900' },
  miniBadges: { flexDirection: 'row', gap: 5 },
  miniBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7 },
  miniBadgeText: { fontSize: 11, fontWeight: '700' },
  badgeEmpty: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.45)', borderWidth: 1, borderColor: colors.primaryLight, borderStyle: 'dashed' },
  badgeEmptyText: { fontSize: 10, color: colors.primary, fontWeight: '600' },
  specialLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  specialLabel: { fontSize: 11, fontWeight: '600' },
  addFab: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', shadowColor: colors.primary, shadowOffset: {width:0,height:3}, shadowOpacity:0.35, shadowRadius:6, elevation:4 },

  // タイムライン
  scroll: { flex: 1 },
  gridContainer: { position: 'relative' },

  hourRow: {
    height: HOUR_H,
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderTopWidth: 0.5,
    borderTopColor: '#E5DCF0',
  },
  hourRowEnd: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderTopWidth: 0.5,
    borderTopColor: '#E5DCF0',
  },
  hourLabel: { width: LABEL_W, fontSize: 11, color: colors.textLight, fontWeight: '500', paddingLeft: 12, paddingTop: 4 },
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
  eventTitle: { fontSize: 12, fontWeight: '700', color: '#FFFFFF' },
  eventTime:  { fontSize: 10, color: 'rgba(255,255,255,0.9)', marginTop: 1 },

  // モーダル
  modalOverlay: { flex: 1, backgroundColor: 'rgba(45,27,105,0.4)', justifyContent: 'center', paddingHorizontal: 20 },
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
});
