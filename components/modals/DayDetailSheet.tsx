import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TouchableWithoutFeedback,
  StyleSheet, Animated, Dimensions, TextInput,
  Image, ScrollView, Platform, Alert, Keyboard,
} from 'react-native';
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from 'react-native-draggable-flatlist';
import { Ionicons } from '@expo/vector-icons';
import { Haptics } from '../../utils/haptics';
import * as ImagePicker from 'expo-image-picker';
import { compressPickedImageUri } from '../../utils/compressPickedImage';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { WheelPicker } from '../ui/WheelPicker';
import { colors } from '../../constants/colors';
import { NoteItem, Stamp } from '../../types';
import { formatFullDate, addDays, formatDate, parseDate } from '../../utils/dateUtils';
import { requestNotificationPermission, scheduleNotification, cancelNotification } from '../../utils/notifications';
import { useTranslation } from '../../constants/i18n';

const PICKER_YEARS = Array.from({ length: 21 }, (_, i) => 2020 + i);
const PICKER_MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const MONTH_DAYS = [31,29,31,30,31,30,31,31,30,31,30,31];

const { height: SCREEN_H } = Dimensions.get('window');
// 月表示でも背景（カレンダー）が見えるようにコンパクト化
const SHEET_H = SCREEN_H * 0.56;

type StampPos = 'main' | 'mini-left' | 'mini-right';

interface Props {
  visible: boolean;
  date: string;
  onClose: () => void;
  onOpenAddStamp: () => void;
  onOpenEditStamp?: (stamp: Stamp) => void;
  onDateChange?: (newDate: string) => void;
}

export function DayDetailSheet({ visible, date, onClose, onOpenAddStamp, onOpenEditStamp, onDateChange }: Props) {
  const { t, locale } = useTranslation();
  const stampTabs = React.useMemo(
    () =>
      [
        { key: 'main' as const, label: t('recurring.mainBand') },
        { key: 'mini-left' as const, label: t('recurring.miniLeft') },
        { key: 'mini-right' as const, label: t('recurring.miniRight') },
      ] as const,
    [t]
  );
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
  const [shouldRender, setShouldRender] = useState(false);

  const entry = useCalendarStore((s) => s.getEntry(date));
  const setMainStamp = useCalendarStore((s) => s.setMainStamp);
  const setMiniStamp = useCalendarStore((s) => s.setMiniStamp);
  const setNotes = useCalendarStore((s) => s.setNotes);
  const setNoteItems = useCalendarStore((s) => s.setNoteItems);
  const updateTimeSlot = useCalendarStore((s) => s.updateTimeSlot);
  const setImageUri = useCalendarStore((s) => s.setImageUri);

  const stamps = useStampStore((s) => s.stamps);
  const addImageStamp = useStampStore((s) => s.addImageStamp);
  const removeStamp = useStampStore((s) => s.removeStamp);
  const imageStamps = useStampStore((s) => s.imageStamps)();

  const mainStamps = stamps.filter((s) => s.isMain !== false && s.isEnabled !== false && !s.isImageStamp);
  const miniStamps = stamps.filter((s) => (s.isMain === false || s.isMain === undefined) && s.isEnabled !== false && !s.isImageStamp);
  const displayStamps = activePos === 'main' ? mainStamps : miniStamps;

  const [noteItems, setNoteItemsLocal] = useState<NoteItem[]>([]);

  const formatTimeInput = (input: string): string => {
    const digits = input.replace(/\D/g, '').slice(0, 4);
    if (digits.length <= 2) return digits;
    return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  };
  const [keyboardPad, setKeyboardPad] = useState(0);

  useEffect(() => {
    const showEv = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEv = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEv, (e) => setKeyboardPad(e.endCoordinates.height));
    const hideSub = Keyboard.addListener(hideEv, () => setKeyboardPad(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  useEffect(() => {
    if (visible) {
      setShouldRender(true);
      setActivePos('main');
      // noteItems がある場合はそれを使い、旧string[]・古いnotesも移行
      if (entry?.noteItems !== undefined && entry.noteItems.length > 0) {
        const items = entry.noteItems.map((item: any, i: number) =>
          typeof item === 'string'
            ? { id: `migrated_${i}`, text: item }
            : item
        ) as NoteItem[];
        setNoteItemsLocal(items);
      } else if (entry?.notes) {
        setNoteItemsLocal([{ id: `migrated_0`, text: entry.notes }]);
      } else {
        setNoteItemsLocal([]);
      }
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
      }).start(() => setShouldRender(false));
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
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      const uri = await compressPickedImageUri(result.assets[0].uri);
      const stamp = addImageStamp(uri);
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
    Alert.alert(t('dayDetail.delImageStampTitle'), t('dayDetail.delImageStampMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'), style: 'destructive', onPress: () => {
          if (entry?.imageUri === stamp.imageUri) setImageUri(date, undefined);
          removeStamp(stamp.id);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        },
      },
    ]);
  };

  const selectedStampId = getSelectedStampId();

  const handleSave = async () => {
    const allValid = noteItems.filter((n) => n.text.trim() !== '');
    const needsNotif = allValid.some(i => i.notificationEnabled && i.time && i.time.length === 5);
    const granted = needsNotif ? await requestNotificationPermission() : false;

    const updated = await Promise.all(allValid.map(async (item) => {
      if (item.notificationEnabled && item.time && item.time.length === 5 && granted) {
        if (item.notificationId) await cancelNotification(item.notificationId);
        const result = await scheduleNotification(
          date,
          item.time,
          item.text || t('dayDetail.defaultNoteTitle'),
          t('daily.notifSummary', { time: item.time })
        );
        return { ...item, notificationId: result.id ?? undefined };
      } else if (!item.notificationEnabled && item.notificationId) {
        await cancelNotification(item.notificationId);
        return { ...item, notificationId: undefined };
      }
      return item;
    }));

    setNoteItems(date, updated);

    for (const item of updated.filter(n => n.fromTimeSlotId)) {
      updateTimeSlot(date, item.fromTimeSlotId!, {
        title: item.text,
        startTime: item.time ?? '',
        endTime: item.endTime ?? '',
        notificationEnabled: item.notificationEnabled ?? false,
        notificationId: item.notificationId,
      });
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  if (!shouldRender) return null;

  return (
    <>
      <Animated.View
        style={[styles.sheet, { transform: [{ translateY: slideAnim }], pointerEvents: 'auto' }]}
      >
        <View style={{ flex: 1 }}>
                {/* Handle */}
                <View style={styles.handle} />

                {/* Header */}
                <View style={styles.header}>
                  <TouchableOpacity style={styles.arrowBtn} onPress={() => goDay(-1)}>
                    <Text style={styles.arrowText}>‹</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={openDatePicker} style={{ flex: 1 }}>
                    <Text style={styles.dateText}>{formatFullDate(date, locale)}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.arrowBtn} onPress={() => goDay(1)}>
                    <Text style={styles.arrowText}>›</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                    <Text style={styles.closeBtnText}>✕</Text>
                  </TouchableOpacity>
                </View>

                <ScrollView
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="always"
                  // 下の余白を最小化（背景が見える割合を増やす）
                  contentContainerStyle={{ paddingBottom: keyboardPad + 6 }}
                >

                  {/* ─ スタンプ ─ */}
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>{t('dayDetail.stamp')}</Text>
                    <View style={styles.tabs}>
                      {stampTabs.map((tab) => (
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
                          onLongPress={() => {
                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                            onOpenEditStamp?.(stamp);
                          }}
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
                    <Text style={styles.sectionLabel}>{t('dayDetail.imageStamp')}</Text>
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
                        <Text style={styles.imageAddLabel}>{t('settings.add')}</Text>
                      </TouchableOpacity>
                    </ScrollView>
                  </View>

                  {/* ─ メモ・予定（複数） ─ */}
                  <View style={styles.section}>
                    <View style={styles.noteHeader}>
                      <Text style={styles.sectionLabel}>{t('dayDetail.notes')}</Text>
                      <TouchableOpacity
                        style={styles.noteAddBtn}
                        onPress={() => {
                          Haptics.selectionAsync();
                          setNoteItemsLocal((prev) => [
                            ...prev,
                            { id: `item_${Date.now()}`, text: '', time: '', notificationEnabled: false },
                          ]);
                        }}
                      >
                        <Text style={styles.noteAddBtnText}>{t('dayDetail.addLine')}</Text>
                      </TouchableOpacity>
                    </View>

                    <DraggableFlatList
                      data={noteItems}
                      keyExtractor={(item) => item.id}
                      onDragEnd={({ data }) => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setNoteItemsLocal(data);
                      }}
                      scrollEnabled={false}
                      renderItem={({ item, drag, isActive }: RenderItemParams<NoteItem>) => {
                        const idx = noteItems.findIndex((n) => n.id === item.id);
                        return (
                          <ScaleDecorator>
                            <View style={[styles.noteItemCard, isActive && styles.noteItemCardActive]}>
                              {/* 1行目：ドラッグハンドル ＋ 通知ベル ＋ 時間 ＋ 削除 */}
                              <View style={styles.noteItemTopRow}>
                                <TouchableOpacity
                                  onLongPress={drag}
                                  delayLongPress={150}
                                  style={styles.dragHandle}
                                >
                                  <Ionicons name="reorder-three-outline" size={20} color={colors.textLight} />
                                </TouchableOpacity>
                                <TouchableOpacity
                                  onPress={() => {
                                    Haptics.selectionAsync();
                                    const next = [...noteItems];
                                    next[idx] = { ...item, notificationEnabled: !item.notificationEnabled };
                                    setNoteItemsLocal(next);
                                  }}
                                >
                                  <Ionicons
                                    name={item.notificationEnabled ? 'notifications' : 'notifications-outline'}
                                    size={18}
                                    color={item.notificationEnabled ? colors.primary : colors.textLight}
                                  />
                                </TouchableOpacity>
                                <TextInput
                                  style={styles.noteTimeInput}
                                  value={item.time ?? ''}
                                  onChangeText={(t) => {
                                    const next = [...noteItems];
                                    next[idx] = { ...item, time: formatTimeInput(t) };
                                    setNoteItemsLocal(next);
                                  }}
                                  placeholder="--:--"
                                  placeholderTextColor={colors.textLight}
                                  keyboardType="number-pad"
                                  maxLength={5}
                                />
                                <Text style={styles.timeSep}>{locale === 'en' ? '–' : '〜'}</Text>
                                <TextInput
                                  style={styles.noteTimeInput}
                                  value={item.endTime ?? ''}
                                  onChangeText={(t) => {
                                    const next = [...noteItems];
                                    next[idx] = { ...item, endTime: formatTimeInput(t) };
                                    setNoteItemsLocal(next);
                                  }}
                                  placeholder="--:--"
                                  placeholderTextColor={colors.textLight}
                                  keyboardType="number-pad"
                                  maxLength={5}
                                />
                                <TouchableOpacity
                                  style={{ marginLeft: 'auto' }}
                                  onPress={() => {
                                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                    setNoteItemsLocal((prev) => prev.filter((n) => n.id !== item.id));
                                  }}
                                >
                                  <Ionicons name="close-circle" size={18} color="#EF4444" />
                                </TouchableOpacity>
                              </View>
                              {/* 2行目：内容 */}
                              <TextInput
                                style={styles.noteItemInput}
                                value={item.text}
                                onChangeText={(text) => {
                                  const next = [...noteItems];
                                  next[idx] = { ...item, text };
                                  setNoteItemsLocal(next);
                                }}
                                placeholder={t('dayDetail.notePlaceholder')}
                                placeholderTextColor={colors.textLight}
                                multiline
                              />
                              {/* 3行目：URL */}
                              <View style={styles.urlRow}>
                                <Ionicons name="link-outline" size={14} color={colors.textLight} />
                                <TextInput
                                  style={styles.urlInput}
                                  value={item.url ?? ''}
                                  onChangeText={(url) => {
                                    const next = [...noteItems];
                                    next[idx] = { ...item, url: url || undefined };
                                    setNoteItemsLocal(next);
                                  }}
                                  placeholder={t('dayDetail.urlPlaceholder')}
                                  placeholderTextColor={colors.textLight}
                                  keyboardType="url"
                                  autoCapitalize="none"
                                  autoCorrect={false}
                                />
                              </View>
                            </View>
                          </ScaleDecorator>
                        );
                      }}
                    />

                    {noteItems.length === 0 && (
                      <TouchableOpacity
                        style={styles.noteEmptyBtn}
                        onPress={() => {
                          Haptics.selectionAsync();
                          setNoteItemsLocal([{ id: `item_${Date.now()}`, text: '', time: '', notificationEnabled: false }]);
                        }}
                      >
                        <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
                        <Text style={styles.noteEmptyBtnText}>{t('dayDetail.addNotes')}</Text>
                      </TouchableOpacity>
                    )}

                    {/* 確定ボタン（2つ） */}
                    <View style={styles.saveBtnRow}>
                      <TouchableOpacity
                        style={[styles.saveBtn, styles.saveBtnClose]}
                        onPress={async () => {
                          await handleSave();
                          onClose();
                        }}
                      >
                        <Ionicons name="checkmark" size={14} color="#FFFFFF" />
                        <Text style={styles.saveBtnText}>{t('dayDetail.saveClose')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.saveBtn, styles.saveBtnNext]}
                        onPress={async () => {
                          await handleSave();
                          // 翌日に移動してリセット
                          const next = formatDate(addDays(parseDate(date), 1));
                          onDateChange?.(next);
                          setNoteItemsLocal([]);
                        }}
                      >
                        <Ionicons name="arrow-forward" size={14} color="#FFFFFF" />
                        <Text style={styles.saveBtnText}>{t('dayDetail.saveNext')}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                </ScrollView>
        </View>
      </Animated.View>

      {/* ── 年月日ピッカー ── */}
      <Modal
        transparent
        animationType="fade"
        visible={datePickerVisible}
        onRequestClose={() => setDatePickerVisible(false)}
        statusBarTranslucent
      >
        <TouchableWithoutFeedback onPress={() => setDatePickerVisible(false)}>
          <View style={styles.dpOverlay}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={styles.dpCard}>
                <Text style={styles.dpTitle}>{t('picker.date')}</Text>
                <View style={styles.dpRow}>
                  <WheelPicker
                    items={PICKER_YEARS}
                    selectedIndex={PICKER_YEARS.indexOf(pYear) >= 0 ? PICKER_YEARS.indexOf(pYear) : 0}
                    onChange={(i) => setPYear(PICKER_YEARS[i])}
                    formatItem={(v) => t('picker.yearFmt', { v })}
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
                    formatItem={(v) => t('picker.monthFmt', { v })}
                    width={72}
                  />
                  <WheelPicker
                    items={pickerDays}
                    selectedIndex={Math.min(pDay, pickerDays.length) - 1}
                    onChange={(i) => setPDay(pickerDays[i])}
                    formatItem={(v) => t('picker.dayFmt', { v })}
                    width={72}
                  />
                </View>
                <View style={styles.dpBtns}>
                  <TouchableOpacity style={styles.dpCancelBtn} onPress={() => setDatePickerVisible(false)}>
                    <Text style={styles.dpCancelText}>{t('common.cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.dpConfirmBtn} onPress={confirmDatePicker}>
                    <Text style={styles.dpConfirmText}>{t('picker.confirm')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: SHEET_H,
    backgroundColor: 'rgba(248,250,255,0.94)',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 16,
    paddingBottom: 8,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.10,
    shadowRadius: 12,
    elevation: 20,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: '#BFDBFE',
    alignSelf: 'center', marginTop: 8, marginBottom: 4,
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: '#F0E8F8', marginBottom: 4,
  },
  dateText: { fontSize: 14, fontWeight: '800', color: colors.text, flex: 1, textAlign: 'center' },
  arrowBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: '#F5EFF5', alignItems: 'center', justifyContent: 'center',
  },
  arrowText: { fontSize: 22, color: colors.primary, lineHeight: 26 },
  closeBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: '#F0E6F0', alignItems: 'center', justifyContent: 'center',
  },
  closeBtnText: { fontSize: 12, color: colors.textSecondary, fontWeight: '700' },

  section: { marginTop: 10 },
  sectionLabel: { fontSize: 12, fontWeight: '800', color: colors.textSecondary, marginBottom: 8 },

  tabs: {
    flexDirection: 'row', backgroundColor: '#F5EFF5',
    borderRadius: 12, padding: 3, marginBottom: 10,
  },
  tab: { flex: 1, paddingVertical: 7, borderRadius: 10, alignItems: 'center' },
  tabActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#3B82F6', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15, shadowRadius: 4, elevation: 2,
  },
  tabText: { fontSize: 13, fontWeight: '600', color: colors.textLight },
  tabTextActive: { color: colors.primary, fontWeight: '700' },

  stampGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  stampItem: { width: '20%', alignItems: 'center', paddingVertical: 6 },
  stampCircle: {
    width: 46, height: 46, borderRadius: 14,
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
    width: 46, height: 46, borderRadius: 14,
    borderWidth: 2, borderColor: colors.primaryLight, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', margin: 6,
  },
  addStampText: { fontSize: 20, color: colors.primary },

  // 画像スタンプ
  imageStampRow: { flexDirection: 'row' },
  imageStampWrap: { marginRight: 10, position: 'relative' },
  imageStampImg: {
    width: 52, height: 52, borderRadius: 14,
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
    width: 52, height: 52, borderRadius: 14,
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
    backgroundColor: '#DBEAFE', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4,
  },
  noteAddBtnText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  noteItemCard: {
    backgroundColor: '#FFFFFF', borderRadius: 12, padding: 12, marginBottom: 8,
    shadowColor: '#3B82F6', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4, elevation: 1,
    gap: 8,
  },
  noteItemCardActive: {
    shadowOpacity: 0.22, shadowRadius: 10, elevation: 8,
    backgroundColor: '#FAF6FF',
  },
  dragHandle: {
    paddingRight: 4,
  },
  noteItemTopRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  noteTimeInput: {
    backgroundColor: '#F5EFF5', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
    fontSize: 14, fontWeight: '600', color: colors.text, width: 64, textAlign: 'center',
  },
  noteItemRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 8,
  },
  noteItemInput: {
    backgroundColor: '#EFF6FF', borderRadius: 10, padding: 10,
    fontSize: 14, color: colors.text, minHeight: 40, textAlignVertical: 'top',
  },
  urlRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#F0F7FF', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  urlInput: {
    flex: 1, fontSize: 12, color: colors.primary,
  },
  noteDeleteBtn: { paddingTop: 12 },
  noteEmptyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#FFFFFF', borderRadius: 12, padding: 12,
    borderWidth: 1.5, borderColor: colors.primaryLight, borderStyle: 'dashed',
    marginBottom: 8,
  },
  noteEmptyBtnText: { fontSize: 14, color: colors.primary, fontWeight: '600' },
  saveBtnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  saveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: 10,
    paddingVertical: 10,
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25, shadowRadius: 6, elevation: 3,
  },
  saveBtnNext: {
    backgroundColor: '#3B82F6',
  },
  saveBtnClose: {
    backgroundColor: colors.primary,
  },
  saveBtnText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },

  // 通知
  notifRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14,
  },
  notifLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  notifBell: { fontSize: 16 },

  // 年月日ピッカー
  dpOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)', justifyContent: 'center', alignItems: 'center' },
  dpCard: { backgroundColor: '#FDFAFF', borderRadius: 24, padding: 24, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 20, elevation: 10, minWidth: 300 },
  dpTitle: { fontSize: 16, fontWeight: '800', color: colors.text, marginBottom: 16 },
  dpRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 },
  dpBtns: { flexDirection: 'row', gap: 10, width: '100%' },
  dpCancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: '#F5EFF5', alignItems: 'center' },
  dpCancelText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  dpConfirmBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center', shadowColor: colors.primary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 3 },
  dpConfirmText: { fontSize: 14, fontWeight: '800', color: '#FFFFFF' },
});
