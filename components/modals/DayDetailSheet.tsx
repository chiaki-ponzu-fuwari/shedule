import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TouchableWithoutFeedback,
  StyleSheet, Animated, Dimensions, TextInput, Switch,
  Image, ScrollView, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { WheelPicker } from '../ui/WheelPicker';
import { colors } from '../../constants/colors';
import { Stamp } from '../../types';
import { formatFullDate, addDays, formatDate, parseDate } from '../../utils/dateUtils';

const PICKER_YEARS = Array.from({ length: 21 }, (_, i) => 2020 + i);
const PICKER_MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const MONTH_DAYS = [31,29,31,30,31,30,31,31,30,31,30,31];

const { height: SCREEN_H } = Dimensions.get('window');
const SHEET_H = SCREEN_H * 0.88;

type StampPos = 'main' | 'mini-left' | 'mini-right';

const STAMP_TABS: { key: StampPos; label: string }[] = [
  { key: 'main', label: 'メイン帯' },
  { key: 'mini-left', label: 'ミニ左' },
  { key: 'mini-right', label: 'ミニ右' },
];

interface Props {
  visible: boolean;
  date: string;
  onClose: () => void;
  onOpenAddStamp: () => void;
  onDateChange?: (newDate: string) => void;
}

export function DayDetailSheet({ visible, date, onClose, onOpenAddStamp, onDateChange }: Props) {
  const goDay = (n: number) => {
    Haptics.selectionAsync();
    onDateChange?.(formatDate(addDays(parseDate(date), n)));
  };
  const [activePos, setActivePos] = useState<StampPos>('main');

  // 年月日ピッカー
  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [pYear, setPYear] = useState(2026);
  const [pMonth, setPMonth] = useState(1);
  const [pDay, setPDay] = useState(1);

  const openDatePicker = () => {
    const d = parseDate(date);
    setPYear(d.getFullYear());
    setPMonth(d.getMonth() + 1);
    setPDay(d.getDate());
    setDatePickerVisible(true);
  };

  const confirmDatePicker = () => {
    const maxDay = MONTH_DAYS[pMonth - 1];
    const day = Math.min(pDay, maxDay);
    const newDate = `${pYear}-${String(pMonth).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onDateChange?.(newDate);
    setDatePickerVisible(false);
  };

  const pickerDays = Array.from({ length: MONTH_DAYS[pMonth - 1] }, (_, i) => i + 1);
  const slideAnim = useRef(new Animated.Value(SHEET_H)).current;

  const entry = useCalendarStore((s) => s.getEntry(date));
  const setMainStamp = useCalendarStore((s) => s.setMainStamp);
  const setMiniStamp = useCalendarStore((s) => s.setMiniStamp);
  const setNotes = useCalendarStore((s) => s.setNotes);
  const setNoteItems = useCalendarStore((s) => s.setNoteItems);
  const setStartTime = useCalendarStore((s) => s.setStartTime);
  const setEndTime = useCalendarStore((s) => s.setEndTime);
  const setNotification = useCalendarStore((s) => s.setNotification);
  const setImageUri = useCalendarStore((s) => s.setImageUri);

  const stamps = useStampStore((s) => s.stamps);
  const addImageStamp = useStampStore((s) => s.addImageStamp);
  const removeStamp = useStampStore((s) => s.removeStamp);
  const imageStamps = useStampStore((s) => s.imageStamps)();

  const mainStamps = stamps.filter((s) => s.isMain !== false && s.isEnabled !== false && !s.isImageStamp);
  const miniStamps = stamps.filter((s) => (s.isMain === false || s.isMain === undefined) && s.isEnabled !== false && !s.isImageStamp);
  const displayStamps = activePos === 'main' ? mainStamps : miniStamps;

  const [noteItems, setNoteItemsLocal] = useState<string[]>([]);
  const [startVal, setStartVal] = useState('');
  const [endVal, setEndVal] = useState('');

  useEffect(() => {
    if (visible) {
      setActivePos('main');
      // noteItems がある場合はそれを使い、古い notes があれば移行
      if (entry?.noteItems !== undefined) {
        setNoteItemsLocal(entry.noteItems);
      } else if (entry?.notes) {
        setNoteItemsLocal([entry.notes]);
      } else {
        setNoteItemsLocal([]);
      }
      setStartVal(entry?.startTime ?? '');
      setEndVal(entry?.endTime ?? '');
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
  }, [visible, date]);

  const getSelectedStampId = (): string | undefined => {
    if (!entry) return undefined;
    if (activePos === 'main') return entry.mainStampId;
    if (activePos === 'mini-left') return entry.miniStamps?.left;
    return entry.miniStamps?.right;
  };

  const handleStampPress = (stamp: Stamp) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const selected = getSelectedStampId();
    const newId = selected === stamp.id ? undefined : stamp.id;
    if (activePos === 'main') setMainStamp(date, newId);
    else if (activePos === 'mini-left') setMiniStamp(date, 'left', newId);
    else setMiniStamp(date, 'right', newId);
  };

  // 新しい画像を選んで画像スタンプとして保存 → その日に設定
  const handleAddImageStamp = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      const stamp = addImageStamp(result.assets[0].uri);
      setImageUri(date, stamp.imageUri);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  // 既存画像スタンプをこの日に設定（トグル）
  const handleSelectImageStamp = (stamp: Stamp) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const current = entry?.imageUri;
    setImageUri(date, current === stamp.imageUri ? undefined : stamp.imageUri);
  };

  // 画像スタンプを削除（この日の割り当ても解除）
  const handleDeleteImageStamp = (stamp: Stamp) => {
    Alert.alert('画像スタンプを削除', 'このスタンプを削除しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除', style: 'destructive', onPress: () => {
          if (entry?.imageUri === stamp.imageUri) setImageUri(date, undefined);
          removeStamp(stamp.id);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        },
      },
    ]);
  };

  const selectedStampId = getSelectedStampId();

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
              <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={{ flex: 1 }}
              >
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

                <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

                  {/* ─ スタンプ ─ */}
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>スタンプ</Text>
                    <View style={styles.tabs}>
                      {STAMP_TABS.map((tab) => (
                        <TouchableOpacity
                          key={tab.key}
                          style={[styles.tab, activePos === tab.key && styles.tabActive]}
                          onPress={() => { Haptics.selectionAsync(); setActivePos(tab.key); }}
                        >
                          <Text style={[styles.tabText, activePos === tab.key && styles.tabTextActive]}>
                            {tab.label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    <View style={styles.stampGrid}>
                      {displayStamps.map((stamp) => (
                        <TouchableOpacity
                          key={stamp.id}
                          style={styles.stampItem}
                          onPress={() => handleStampPress(stamp)}
                          activeOpacity={0.75}
                        >
                          <View style={[
                            styles.stampCircle,
                            { backgroundColor: stamp.bgColor },
                            selectedStampId === stamp.id && styles.stampCircleSelected,
                          ]}>
                            <Text style={[styles.stampText, { color: stamp.textColor }]}>{stamp.text}</Text>
                          </View>
                          {selectedStampId === stamp.id && <View style={styles.selectedDot} />}
                        </TouchableOpacity>
                      ))}
                      <TouchableOpacity style={styles.addStampBtn} onPress={onOpenAddStamp}>
                        <Text style={styles.addStampText}>＋</Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* ─ 画像スタンプ ─ */}
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>画像スタンプ</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.imageStampRow}>
                      {/* 保存済み画像スタンプ */}
                      {imageStamps.map((stamp) => {
                        const isIcon = stamp.imageUri?.startsWith('icon://');
                        const iconName = isIcon ? stamp.imageUri!.replace('icon://', '') : '';
                        const isSelected = entry?.imageUri === stamp.imageUri;
                        return (
                          <View key={stamp.id} style={styles.imageStampWrap}>
                            <TouchableOpacity
                              onPress={() => handleSelectImageStamp(stamp)}
                              activeOpacity={0.8}
                            >
                              <View style={[
                                styles.imageStampImg,
                                { backgroundColor: stamp.bgColor },
                                isSelected && styles.imageStampSelected,
                              ]}>
                                {isIcon ? (
                                  <Ionicons name={iconName as any} size={28} color={stamp.textColor} />
                                ) : (
                                  <Image source={{ uri: stamp.imageUri }} style={{ width: '100%', height: '100%', borderRadius: 12 }} />
                                )}
                              </View>
                            </TouchableOpacity>
                            {!stamp.isDefault && (
                              <TouchableOpacity
                                style={styles.imageDeleteBtn}
                                onPress={() => handleDeleteImageStamp(stamp)}
                              >
                                <Ionicons name="close-circle" size={18} color="#EF4444" />
                              </TouchableOpacity>
                            )}
                          </View>
                        );
                      })}
                      {/* 新規追加ボタン */}
                      <TouchableOpacity style={styles.imageAddBtn} onPress={handleAddImageStamp}>
                        <Ionicons name="camera-outline" size={22} color={colors.primary} />
                        <Text style={styles.imageAddLabel}>追加</Text>
                      </TouchableOpacity>
                    </ScrollView>
                  </View>

                  {/* ─ 時間 ─ */}
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>時間</Text>
                    <View style={styles.timeRow}>
                      <View style={styles.timeField}>
                        <Text style={styles.timeLabel}>開始</Text>
                        <TextInput
                          style={styles.timeInput}
                          value={startVal}
                          onChangeText={setStartVal}
                          onBlur={() => setStartTime(date, startVal)}
                          placeholder="09:00"
                          placeholderTextColor={colors.textLight}
                          keyboardType="numbers-and-punctuation"
                          maxLength={5}
                        />
                      </View>
                      <Text style={styles.timeSep}>〜</Text>
                      <View style={styles.timeField}>
                        <Text style={styles.timeLabel}>終了</Text>
                        <TextInput
                          style={styles.timeInput}
                          value={endVal}
                          onChangeText={setEndVal}
                          onBlur={() => setEndTime(date, endVal)}
                          placeholder="18:00"
                          placeholderTextColor={colors.textLight}
                          keyboardType="numbers-and-punctuation"
                          maxLength={5}
                        />
                      </View>
                    </View>
                  </View>

                  {/* ─ メモ・予定（複数） ─ */}
                  <View style={styles.section}>
                    <View style={styles.noteHeader}>
                      <Text style={styles.sectionLabel}>メモ・予定</Text>
                      <TouchableOpacity
                        style={styles.noteAddBtn}
                        onPress={() => {
                          Haptics.selectionAsync();
                          setNoteItemsLocal((prev) => [...prev, '']);
                        }}
                      >
                        <Text style={styles.noteAddBtnText}>＋ 追加</Text>
                      </TouchableOpacity>
                    </View>
                    {noteItems.map((item, idx) => (
                      <View key={idx} style={styles.noteItemRow}>
                        <TextInput
                          style={styles.noteItemInput}
                          value={item}
                          onChangeText={(text) => {
                            const next = [...noteItems];
                            next[idx] = text;
                            setNoteItemsLocal(next);
                          }}
                          placeholder="予定を入力…"
                          placeholderTextColor={colors.textLight}
                          multiline
                        />
                        <TouchableOpacity
                          style={styles.noteDeleteBtn}
                          onPress={() => {
                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                            setNoteItemsLocal((prev) => prev.filter((_, i) => i !== idx));
                          }}
                        >
                          <Ionicons name="close-circle" size={20} color="#EF4444" />
                        </TouchableOpacity>
                      </View>
                    ))}
                    {noteItems.length === 0 && (
                      <TouchableOpacity
                        style={styles.noteEmptyBtn}
                        onPress={() => { Haptics.selectionAsync(); setNoteItemsLocal(['']); }}
                      >
                        <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
                        <Text style={styles.noteEmptyBtnText}>メモ・予定を追加</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={styles.saveBtn}
                      onPress={() => {
                        const filtered = noteItems.filter((s) => s.trim() !== '');
                        setNoteItems(date, filtered);
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        onClose();
                      }}
                    >
                      <Text style={styles.saveBtnText}>確定</Text>
                    </TouchableOpacity>
                  </View>

                  {/* ─ 通知 ─ */}
                  <View style={styles.section}>
                    <View style={styles.notifRow}>
                      <View style={styles.notifLeft}>
                        <Text style={styles.sectionLabel}>通知</Text>
                      </View>
                      <Switch
                        value={entry?.notificationEnabled ?? false}
                        onValueChange={(val) => {
                          Haptics.selectionAsync();
                          setNotification(date, val);
                        }}
                        trackColor={{ false: '#E0D0F0', true: colors.primaryLight }}
                        thumbColor={entry?.notificationEnabled ? colors.primary : '#FFFFFF'}
                      />
                    </View>
                  </View>

                  <View style={{ height: 40 }} />
                </ScrollView>
              </KeyboardAvoidingView>
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>

      {/* ── 年月日ピッカー（同一Modal内オーバーレイ）── */}
      {datePickerVisible && (
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
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(45,27,105,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    height: SHEET_H,
    backgroundColor: '#FDFAFF',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: '#E0D0F0',
    alignSelf: 'center', marginTop: 10, marginBottom: 6,
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: '#F0E8F8', marginBottom: 4,
  },
  dateText: { fontSize: 14, fontWeight: '800', color: colors.text, flex: 1, textAlign: 'center' },
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

  section: { marginTop: 14 },
  sectionLabel: { fontSize: 12, fontWeight: '800', color: colors.textSecondary, marginBottom: 8 },

  tabs: {
    flexDirection: 'row', backgroundColor: '#F5EFF5',
    borderRadius: 12, padding: 3, marginBottom: 10,
  },
  tab: { flex: 1, paddingVertical: 7, borderRadius: 10, alignItems: 'center' },
  tabActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#A78BFA', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15, shadowRadius: 4, elevation: 2,
  },
  tabText: { fontSize: 13, fontWeight: '600', color: colors.textLight },
  tabTextActive: { color: colors.primary, fontWeight: '700' },

  stampGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  stampItem: { width: '20%', alignItems: 'center', paddingVertical: 6 },
  stampCircle: {
    width: 50, height: 50, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  stampCircleSelected: {
    borderWidth: 3, borderColor: colors.primary,
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4, shadowRadius: 6, elevation: 4,
  },
  stampText: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
  selectedDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: colors.primary, marginTop: 3,
  },
  addStampBtn: {
    width: 50, height: 50, borderRadius: 14,
    borderWidth: 2, borderColor: colors.primaryLight, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', margin: 6,
  },
  addStampText: { fontSize: 20, color: colors.primary },

  // 画像スタンプ
  imageStampRow: { flexDirection: 'row' },
  imageStampWrap: { marginRight: 10, position: 'relative' },
  imageStampImg: {
    width: 56, height: 56, borderRadius: 14,
    borderWidth: 2, borderColor: 'transparent',
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  imageStampSelected: {
    borderColor: colors.primary,
  },
  imageDeleteBtn: {
    position: 'absolute', top: -6, right: -6,
  },
  imageAddBtn: {
    width: 56, height: 56, borderRadius: 14,
    borderWidth: 2, borderColor: colors.primaryLight, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', gap: 2,
  },
  imageAddLabel: { fontSize: 10, fontWeight: '700', color: colors.primary },

  // 時間
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  timeField: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 10 },
  timeLabel: { fontSize: 10, fontWeight: '700', color: colors.textSecondary, marginBottom: 4 },
  timeInput: { fontSize: 20, fontWeight: '700', color: colors.text, textAlign: 'center' },
  timeSep: { fontSize: 16, color: colors.textLight, fontWeight: '600' },

  // メモ・予定
  noteHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8,
  },
  noteAddBtn: {
    backgroundColor: '#FFE4F0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4,
  },
  noteAddBtnText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  noteItemRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 8,
  },
  noteItemInput: {
    flex: 1, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 12,
    fontSize: 14, color: colors.text, minHeight: 44, textAlignVertical: 'top',
  },
  noteDeleteBtn: { paddingTop: 12 },
  noteEmptyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#FFFFFF', borderRadius: 12, padding: 12,
    borderWidth: 1.5, borderColor: colors.primaryLight, borderStyle: 'dashed',
    marginBottom: 8,
  },
  noteEmptyBtnText: { fontSize: 14, color: colors.primary, fontWeight: '600' },
  saveBtn: {
    marginTop: 8, backgroundColor: colors.primary,
    borderRadius: 10, paddingVertical: 10, alignItems: 'center',
  },
  saveBtnText: { fontSize: 14, fontWeight: '800', color: '#FFFFFF' },

  // 通知
  notifRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14,
  },
  notifLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  notifBell: { fontSize: 16 },

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
