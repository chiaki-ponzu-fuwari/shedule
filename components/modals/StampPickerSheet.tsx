import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TouchableWithoutFeedback,
  StyleSheet, Animated, Dimensions, FlatList,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { colors } from '../../constants/colors';
import { Stamp } from '../../types';
import { formatMonthDay } from '../../utils/dateUtils';

const { height: SCREEN_H } = Dimensions.get('window');
const SHEET_H = SCREEN_H * 0.55;

type Position = 'main' | 'mini-left' | 'mini-right';

const POSITION_TABS: { key: Position; label: string }[] = [
  { key: 'main', label: 'メイン帯' },
  { key: 'mini-left', label: 'ミニ左' },
  { key: 'mini-right', label: 'ミニ右' },
];

interface Props {
  visible: boolean;
  date: string;
  onClose: () => void;
  onOpenAddStamp: () => void;
}

export function StampPickerSheet({ visible, date, onClose, onOpenAddStamp }: Props) {
  const [activePos, setActivePos] = useState<Position>('main');
  const slideAnim = useRef(new Animated.Value(SHEET_H)).current;

  const entry = useCalendarStore((s) => s.getEntry(date));
  const setMainStamp = useCalendarStore((s) => s.setMainStamp);
  const setMiniStamp = useCalendarStore((s) => s.setMiniStamp);
  const stamps = useStampStore((s) => s.stamps);

  // isMain:true or undefined → メイン帯に表示
  // isMain:false → ミニ専用
  const mainStamps = stamps.filter((s) => s.isMain !== false);
  const miniStamps = stamps.filter((s) => s.isMain === false || s.isMain === undefined);

  const displayStamps = activePos === 'main' ? mainStamps : miniStamps;

  useEffect(() => {
    if (visible) {
      setActivePos('main');
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

  const getSelected = (): string | undefined => {
    if (!entry) return undefined;
    if (activePos === 'main') return entry.mainStampId;
    if (activePos === 'mini-left') return entry.miniStamps?.left;
    return entry.miniStamps?.right;
  };

  const handleStampPress = (stamp: Stamp) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const selected = getSelected();
    const newId = selected === stamp.id ? undefined : stamp.id;

    if (activePos === 'main') {
      setMainStamp(date, newId);
    } else if (activePos === 'mini-left') {
      setMiniStamp(date, 'left', newId);
    } else {
      setMiniStamp(date, 'right', newId);
    }
  };

  const selectedId = getSelected();

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
            <Animated.View
              style={[styles.sheet, { transform: [{ translateY: slideAnim }] }]}
            >
              {/* Handle */}
              <View style={styles.handle} />

              {/* Header */}
              <View style={styles.sheetHeader}>
                <Text style={styles.dateText}>{formatMonthDay(date)}</Text>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Text style={styles.closeBtnText}>✕</Text>
                </TouchableOpacity>
              </View>

              {/* Position tabs */}
              <View style={styles.tabs}>
                {POSITION_TABS.map((tab) => (
                  <TouchableOpacity
                    key={tab.key}
                    style={[styles.tab, activePos === tab.key && styles.tabActive]}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setActivePos(tab.key);
                    }}
                  >
                    <Text style={[styles.tabText, activePos === tab.key && styles.tabTextActive]}>
                      {tab.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Current selection */}
              <View style={styles.currentRow}>
                <Text style={styles.currentLabel}>選択中：</Text>
                {selectedId ? (
                  <CurrentStampPreview stampId={selectedId} />
                ) : (
                  <Text style={styles.noneText}>なし（タップで設定）</Text>
                )}
              </View>

              {/* Stamp grid */}
              <FlatList
                data={displayStamps}
                keyExtractor={(item) => item.id}
                numColumns={5}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.stampItem}
                    onPress={() => handleStampPress(item)}
                    activeOpacity={0.75}
                  >
                    <View
                      style={[
                        styles.stampCircle,
                        { backgroundColor: item.bgColor },
                        selectedId === item.id && styles.stampCircleSelected,
                      ]}
                    >
                      <Text style={[styles.stampText, { color: item.textColor }]}>{item.text}</Text>
                    </View>
                    {selectedId === item.id && <View style={styles.selectedDot} />}
                  </TouchableOpacity>
                )}
                ListFooterComponent={
                  <TouchableOpacity style={styles.addBtn} onPress={onOpenAddStamp}>
                    <Text style={styles.addBtnText}>＋ 新しいスタンプを作る</Text>
                  </TouchableOpacity>
                }
                contentContainerStyle={styles.stampGrid}
                showsVerticalScrollIndicator={false}
              />
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

function CurrentStampPreview({ stampId }: { stampId: string }) {
  const getStamp = useStampStore((s) => s.getStamp);
  const stamp = getStamp(stampId);
  if (!stamp) return null;
  return (
    <View style={[styles.previewBadge, { backgroundColor: stamp.bgColor }]}>
      <Text style={[styles.previewText, { color: stamp.textColor }]}>{stamp.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(45,27,105,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    height: SHEET_H, backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 16, paddingBottom: 20,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: '#E0D0F0',
    alignSelf: 'center', marginTop: 10, marginBottom: 6,
  },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: 8,
  },
  dateText: { fontSize: 17, fontWeight: '800', color: colors.text },
  closeBtn: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: '#F0E6F0', alignItems: 'center', justifyContent: 'center',
  },
  closeBtnText: { fontSize: 12, color: colors.textSecondary, fontWeight: '700' },
  tabs: {
    flexDirection: 'row', backgroundColor: '#F5EFF5',
    borderRadius: 12, padding: 3, marginBottom: 12,
  },
  tab: {
    flex: 1, paddingVertical: 8, borderRadius: 10,
    alignItems: 'center',
  },
  tabActive: { backgroundColor: '#FFFFFF', shadowColor: '#A78BFA', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 4, elevation: 2 },
  tabText: { fontSize: 13, fontWeight: '600', color: colors.textLight },
  tabTextActive: { color: colors.primary, fontWeight: '700' },
  currentRow: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8,
  },
  currentLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  noneText: { fontSize: 12, color: colors.textLight, fontStyle: 'italic' },
  previewBadge: {
    paddingHorizontal: 14, paddingVertical: 4, borderRadius: 8,
  },
  previewText: { fontSize: 14, fontWeight: '800' },
  stampGrid: { paddingBottom: 8 },
  stampItem: {
    width: '20%', alignItems: 'center', paddingVertical: 8,
  },
  stampCircle: {
    width: 52, height: 52, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  stampCircleSelected: {
    borderWidth: 3, borderColor: colors.primary,
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4, shadowRadius: 6, elevation: 4,
  },
  stampText: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
  selectedDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: colors.primary, marginTop: 4,
  },
  addBtn: {
    margin: 8, padding: 14, borderRadius: 12,
    borderWidth: 2, borderColor: colors.primaryLight, borderStyle: 'dashed',
    alignItems: 'center',
  },
  addBtnText: { fontSize: 14, color: colors.primary, fontWeight: '700' },
});
