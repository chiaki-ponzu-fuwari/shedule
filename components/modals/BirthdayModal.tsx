import React, { useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, StyleSheet,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useCalendarStore } from '../../store/calendarStore';
import { colors } from '../../constants/colors';
import { SpecialDate } from '../../types';
import { WheelPicker } from '../ui/WheelPicker';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const ICON_OPTIONS: IoniconName[] = [
  'gift-outline', 'heart-outline', 'star-outline', 'musical-notes-outline',
  'home-outline', 'leaf-outline', 'camera-outline', 'ribbon-outline',
  'balloon-outline', 'rose-outline',
];

const TYPE_OPTIONS: { key: SpecialDate['type']; label: string; icon: IoniconName }[] = [
  { key: 'birthday', label: '誕生日', icon: 'gift-outline' },
  { key: 'anniversary', label: '記念日', icon: 'heart-outline' },
  { key: 'other', label: 'その他', icon: 'star-outline' },
];
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function BirthdayModal({ visible, onClose }: Props) {
  const [name, setName] = useState('');
  const [month, setMonth] = useState(1);
  const [day, setDay] = useState(1);
  const [type, setType] = useState<SpecialDate['type']>('birthday');
  const [selectedEmoji, setSelectedEmoji] = useState<IoniconName>('gift-outline');
  const [color, setColor] = useState('#FF6B9D');

  const addSpecialDate = useCalendarStore((s) => s.addSpecialDate);

  const maxDays = MONTH_DAYS[month - 1];

  const handleSave = () => {
    if (!name.trim()) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    addSpecialDate({
      id: `special_${Date.now()}`,
      name: name.trim(),
      month,
      day: Math.min(day, maxDays),
      color,
      type,
      emoji: selectedEmoji,
    });
    setName('');
    setMonth(1);
    setDay(1);
    onClose();
  };

  const COLOR_OPTIONS = ['#FF6B9D', '#A78BFA', '#34D399', '#60A5FA', '#FBBF24', '#FB923C'];

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
            <Text style={styles.title}>誕生日・記念日</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Type */}
          <Text style={styles.fieldLabel}>種類</Text>
          <View style={styles.typeRow}>
            {TYPE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.key}
                style={[styles.typeBtn, type === opt.key && styles.typeBtnActive]}
                onPress={() => { Haptics.selectionAsync(); setType(opt.key); }}
              >
                <Ionicons name={opt.icon} size={14} color={type === opt.key ? colors.primary : colors.textSecondary} />
                <Text style={[styles.typeBtnText, type === opt.key && styles.typeBtnTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Name */}
          <Text style={styles.fieldLabel}>名前・タイトル</Text>
          <TextInput
            style={styles.nameInput}
            value={name}
            onChangeText={setName}
            placeholder="例: たろうの誕生日、結婚記念日"
            placeholderTextColor={colors.textLight}
          />

          {/* Icon */}
          <Text style={styles.fieldLabel}>アイコン</Text>
          <View style={styles.emojiRow}>
            {ICON_OPTIONS.map((iconName) => (
              <TouchableOpacity
                key={iconName}
                style={[styles.emojiBtn, selectedEmoji === iconName && styles.emojiBtnActive]}
                onPress={() => { Haptics.selectionAsync(); setSelectedEmoji(iconName); }}
              >
                <Ionicons
                  name={iconName}
                  size={22}
                  color={selectedEmoji === iconName ? colors.primary : colors.textSecondary}
                />
              </TouchableOpacity>
            ))}
          </View>

          {/* Date — WheelPickerはScrollView外に配置（ジェスチャー競合回避） */}
          <Text style={styles.fieldLabel}>日付（毎年繰り返し）</Text>
          <View style={styles.datePickerRow}>
            <WheelPicker
              items={MONTHS}
              selectedIndex={month - 1}
              onChange={(i) => {
                const newMonth = i + 1;
                setMonth(newMonth);
                setDay(Math.min(day, MONTH_DAYS[i]));
              }}
              formatItem={(v) => `${v}月`}
              width={110}
            />
            <Text style={styles.dateSep}>—</Text>
            <WheelPicker
              items={Array.from({ length: maxDays }, (_, i) => i + 1)}
              selectedIndex={Math.min(day, maxDays) - 1}
              onChange={(i) => setDay(i + 1)}
              formatItem={(v) => `${v}日`}
              width={110}
            />
          </View>

          {/* Color */}
          <Text style={styles.fieldLabel}>カラー</Text>
          <View style={styles.colorRow}>
            {COLOR_OPTIONS.map((c) => (
              <TouchableOpacity
                key={c}
                style={[styles.colorDot, { backgroundColor: c }, color === c && styles.colorDotSelected]}
                onPress={() => { Haptics.selectionAsync(); setColor(c); }}
              />
            ))}
          </View>

          {/* Save */}
          <TouchableOpacity
            style={[styles.saveBtn, !name.trim() && styles.saveBtnDisabled]}
            onPress={handleSave}
            disabled={!name.trim()}
          >
            <Text style={styles.saveBtnText}>登録する</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(45,27,105,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingBottom: 40, maxHeight: '92%' },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#E0D0F0', alignSelf: 'center', marginTop: 10, marginBottom: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  title: { fontSize: 18, fontWeight: '800', color: colors.text },
  closeBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#F0E6F0', alignItems: 'center', justifyContent: 'center' },
  closeBtnText: { fontSize: 12, color: colors.textSecondary, fontWeight: '700' },
  fieldLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginTop: 16, marginBottom: 8 },
  typeRow: { flexDirection: 'row', gap: 8 },
  typeBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 4 },
  typeBtnActive: { borderColor: colors.primary, backgroundColor: '#FFE4F0' },
  typeBtnText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  typeBtnTextActive: { color: colors.primary },
  nameInput: { borderWidth: 2, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.text },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  emojiBtn: { width: 44, height: 44, borderRadius: 12, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  emojiBtnActive: { borderColor: colors.primary, backgroundColor: '#FFE4F0' },
  emoji: { fontSize: 22 },
  datePickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  dateSep: { fontSize: 22, color: colors.textLight, fontWeight: '700' },
  colorRow: { flexDirection: 'row', gap: 10 },
  colorDot: { width: 36, height: 36, borderRadius: 10 },
  colorDotSelected: { borderWidth: 3, borderColor: colors.text, transform: [{ scale: 1.15 }] },
  saveBtn: { backgroundColor: colors.primary, borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 16, marginBottom: 8, shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  saveBtnDisabled: { backgroundColor: colors.textLight, shadowOpacity: 0 },
  saveBtnText: { fontSize: 16, fontWeight: '800', color: '#FFFFFF' },
});
