import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, SafeAreaView, Platform, Alert, Switch, Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStampStore } from '../../store/stampStore';
import { useGroupStore } from '../../store/groupStore';
import { useCalendarStore } from '../../store/calendarStore';
import { colors } from '../../constants/colors';
import { AddStampModal } from '../../components/modals/AddStampModal';
import { RecurringModal } from '../../components/modals/RecurringModal';
import { BirthdayModal } from '../../components/modals/BirthdayModal';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const stamps = useStampStore((s) => s.stamps);
  const removeStamp = useStampStore((s) => s.removeStamp);
  const toggleEnabled = useStampStore((s) => s.toggleEnabled);
  const resetStamps = useStampStore((s) => s.resetToDefaults);
  const imageStamps = useStampStore((s) => s.imageStamps)();
  const myName = useGroupStore((s) => s.myName);
  const setMyName = useGroupStore((s) => s.setMyName);
  const recurringSchedules = useCalendarStore((s) => s.recurringSchedules);
  const removeRecurring = useCalendarStore((s) => s.removeRecurring);
  const specialDates = useCalendarStore((s) => s.specialDates);
  const removeSpecialDate = useCalendarStore((s) => s.removeSpecialDate);

  const [addStampVisible, setAddStampVisible] = useState(false);
  const [editingStamp, setEditingStamp] = useState<typeof stamps[0] | undefined>(undefined);
  const [recurringVisible, setRecurringVisible] = useState(false);
  const [birthdayVisible, setBirthdayVisible] = useState(false);
  const [nameEdit, setNameEdit] = useState(myName);
  const [nameEditing, setNameEditing] = useState(false);

  const mainStamps = stamps.filter((s) => s.isMain !== false);
  const miniStamps = stamps.filter((s) => s.isMain === false);

  const openEdit = (stamp: typeof stamps[0]) => {
    setEditingStamp(stamp);
    setAddStampVisible(true);
  };

  const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

  return (
    <SafeAreaView style={[styles.container, { paddingTop: Platform.OS === 'android' ? insets.top : 0 }]}>
      <LinearGradient colors={['#FFE4F0', '#EDE9FE']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.header}>
        <Text style={styles.headerTitle}>設定</Text>
      </LinearGradient>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Profile */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>プロフィール</Text>
          <View style={styles.card}>
            <View style={styles.profileRow}>
              <View style={styles.profileAvatar}>
                <Text style={styles.profileAvatarText}>{nameEdit.charAt(0) || '🌸'}</Text>
              </View>
              {nameEditing ? (
                <TextInput
                  style={styles.nameInput}
                  value={nameEdit}
                  onChangeText={setNameEdit}
                  onBlur={() => {
                    setMyName(nameEdit);
                    setNameEditing(false);
                  }}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={() => {
                    setMyName(nameEdit);
                    setNameEditing(false);
                  }}
                />
              ) : (
                <TouchableOpacity
                  style={styles.nameRow}
                  onPress={() => setNameEditing(true)}
                >
                  <Text style={styles.profileName}>{myName}</Text>
                  <Ionicons name="pencil-outline" size={14} color={colors.textLight} />
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>

        {/* Stamps */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>スタンプ管理</Text>
            <TouchableOpacity
              style={styles.sectionBtn}
              onPress={() => setAddStampVisible(true)}
            >
              <Ionicons name="add" size={16} color={colors.primary} />
              <Text style={styles.sectionBtnText}>作成</Text>
            </TouchableOpacity>
          </View>

          {/* メインスタンプ */}
          <Text style={styles.subLabel}>メインスタンプ</Text>
          {mainStamps.map((stamp) => (
            <StampRow
              key={stamp.id}
              stamp={stamp}
              onEdit={() => openEdit(stamp)}
              onToggle={() => { Haptics.selectionAsync(); toggleEnabled(stamp.id); }}
              onDelete={stamp.isDefault ? undefined : () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                Alert.alert('削除', `「${stamp.text}」を削除しますか？`, [
                  { text: 'キャンセル', style: 'cancel' },
                  { text: '削除', style: 'destructive', onPress: () => removeStamp(stamp.id) },
                ]);
              }}
            />
          ))}

          {/* ミニスタンプ */}
          <Text style={[styles.subLabel, { marginTop: 16 }]}>ミニスタンプ</Text>
          {miniStamps.map((stamp) => (
            <StampRow
              key={stamp.id}
              stamp={stamp}
              onEdit={() => openEdit(stamp)}
              onToggle={() => { Haptics.selectionAsync(); toggleEnabled(stamp.id); }}
              onDelete={stamp.isDefault ? undefined : () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                Alert.alert('削除', `「${stamp.text}」を削除しますか？`, [
                  { text: 'キャンセル', style: 'cancel' },
                  { text: '削除', style: 'destructive', onPress: () => removeStamp(stamp.id) },
                ]);
              }}
            />
          ))}

          <TouchableOpacity
            style={[styles.dangerBtn, { marginTop: 16 }]}
            onPress={() => {
              Alert.alert('スタンプをリセット', 'カスタムスタンプも含め、全てデフォルトに戻します。', [
                { text: 'キャンセル', style: 'cancel' },
                { text: 'リセット', style: 'destructive', onPress: resetStamps },
              ]);
            }}
          >
            <Ionicons name="refresh-outline" size={14} color="#EF4444" />
            <Text style={styles.dangerBtnText}>デフォルトに戻す</Text>
          </TouchableOpacity>

          {/* 画像スタンプ */}
          {imageStamps.length > 0 && (
            <>
              <Text style={[styles.subLabel, { marginTop: 16 }]}>画像スタンプ</Text>
              <View style={styles.imageStampGrid}>
                {imageStamps.map((stamp) => (
                  <View key={stamp.id} style={styles.imageStampItem}>
                    <Image source={{ uri: stamp.imageUri }} style={styles.imageStampImg} />
                    <TouchableOpacity
                      style={styles.imageStampDelete}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        Alert.alert('削除', 'この画像スタンプを削除しますか？', [
                          { text: 'キャンセル', style: 'cancel' },
                          { text: '削除', style: 'destructive', onPress: () => removeStamp(stamp.id) },
                        ]);
                      }}
                    >
                      <Ionicons name="close-circle" size={20} color="#EF4444" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            </>
          )}
        </View>

        {/* Recurring */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>繰り返し予定</Text>
            <TouchableOpacity
              style={styles.sectionBtn}
              onPress={() => setRecurringVisible(true)}
            >
              <Ionicons name="add" size={16} color={colors.primary} />
              <Text style={styles.sectionBtnText}>設定</Text>
            </TouchableOpacity>
          </View>
          {recurringSchedules.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>繰り返し予定はありません</Text>
            </View>
          ) : (
            recurringSchedules.map((rs) => (
              <View key={rs.id} style={styles.recurringItem}>
                <View style={styles.recurringInfo}>
                  <Text style={styles.recurringName}>{rs.name}</Text>
                  <Text style={styles.recurringDays}>
                    {rs.daysOfWeek.map((d) => WEEKDAY_LABELS[d]).join('・')}曜 /
                    {rs.stampPosition === 'main' ? 'メイン帯' : rs.stampPosition === 'mini-left' ? 'ミニ左' : 'ミニ右'}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    removeRecurring(rs.id);
                  }}
                  style={styles.deleteBtn}
                >
                  <Ionicons name="trash-outline" size={16} color="#EF4444" />
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        {/* Birthday */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>誕生日・記念日</Text>
            <TouchableOpacity
              style={styles.sectionBtn}
              onPress={() => setBirthdayVisible(true)}
            >
              <Ionicons name="add" size={16} color={colors.primary} />
              <Text style={styles.sectionBtnText}>追加</Text>
            </TouchableOpacity>
          </View>
          {specialDates.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>登録された誕生日・記念日はありません</Text>
            </View>
          ) : (
            specialDates.map((sd) => (
              <View key={sd.id} style={styles.specialItem}>
                <View style={[styles.specialIcon, { backgroundColor: sd.color + '22' }]}>
                  <Ionicons name={(sd.emoji as any) || 'gift-outline'} size={20} color={sd.color} />
                </View>
                <View style={styles.specialInfo}>
                  <Text style={styles.specialName}>{sd.name}</Text>
                  <Text style={styles.specialDate}>{sd.month}月{sd.day}日 毎年</Text>
                </View>
                <TouchableOpacity
                  style={styles.deleteBtn}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    removeSpecialDate(sd.id);
                  }}
                >
                  <Ionicons name="trash-outline" size={16} color="#EF4444" />
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        {/* About */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>アプリについて</Text>
          <View style={styles.card}>
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>バージョン</Text>
              <Text style={styles.aboutValue}>1.0.0</Text>
            </View>
            <View style={[styles.aboutRow, { borderBottomWidth: 0 }]}>
              <Text style={styles.aboutLabel}>スタンプ数</Text>
              <Text style={styles.aboutValue}>{stamps.length}個</Text>
            </View>
          </View>
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>

      <AddStampModal
        visible={addStampVisible}
        editStamp={editingStamp}
        onClose={() => { setAddStampVisible(false); setEditingStamp(undefined); }}
      />
      <RecurringModal visible={recurringVisible} onClose={() => setRecurringVisible(false)} />
      <BirthdayModal visible={birthdayVisible} onClose={() => setBirthdayVisible(false)} />
    </SafeAreaView>
  );
}

// ── スタンプ行コンポーネント ──
import { Stamp } from '../../types';

function StampRow({
  stamp,
  onEdit,
  onToggle,
  onDelete,
}: {
  stamp: Stamp;
  onEdit: () => void;
  onToggle: () => void;
  onDelete?: () => void;
}) {
  const isEnabled = stamp.isEnabled !== false;
  return (
    <View style={[rowStyles.row, !isEnabled && rowStyles.rowDisabled]}>
      <View style={[rowStyles.badge, { backgroundColor: stamp.bgColor, opacity: isEnabled ? 1 : 0.4 }]}>
        <Text style={[rowStyles.badgeText, { color: stamp.textColor }]}>{stamp.text}</Text>
      </View>
      <View style={rowStyles.info}>
        <Text style={rowStyles.label}>{stamp.text}</Text>
        <Text style={rowStyles.sub}>{stamp.isDefault ? 'デフォルト' : 'カスタム'}</Text>
      </View>
      <Switch
        value={isEnabled}
        onValueChange={onToggle}
        trackColor={{ false: '#E0D0F0', true: colors.primaryLight }}
        thumbColor={isEnabled ? colors.primary : '#FFFFFF'}
        style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
      />
      <TouchableOpacity onPress={onEdit} style={rowStyles.editBtn}>
        <Ionicons name="pencil" size={15} color={colors.primary} />
      </TouchableOpacity>
      {onDelete ? (
        <TouchableOpacity onPress={onDelete} style={rowStyles.deleteBtn}>
          <Ionicons name="trash-outline" size={15} color="#EF4444" />
        </TouchableOpacity>
      ) : (
        <View style={rowStyles.deletePlaceholder} />
      )}
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#FFFFFF', borderRadius: 12, padding: 10,
    marginBottom: 8,
    shadowColor: '#A78BFA', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 4, elevation: 1,
  },
  badge: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 14, fontWeight: '900' },
  info: { flex: 1 },
  label: { fontSize: 14, fontWeight: '700', color: colors.text },
  sub: { fontSize: 11, color: colors.textSecondary, marginTop: 1 },
  editBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: '#FFE4F0', alignItems: 'center', justifyContent: 'center' },
  deleteBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: '#FFF0F0', alignItems: 'center', justifyContent: 'center' },
  deletePlaceholder: { width: 34 },
  rowDisabled: { opacity: 0.75 },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  specialItem: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 12, marginBottom: 8, shadowColor: '#A78BFA', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  specialIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  specialInfo: { flex: 1 },
  specialName: { fontSize: 14, fontWeight: '700', color: colors.text },
  specialDate: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  header: { paddingHorizontal: 20, paddingVertical: 14 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: colors.text },
  scroll: { flex: 1 },
  section: { paddingHorizontal: 16, marginTop: 20 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  sectionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FFE4F0', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  sectionBtnText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  card: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16, shadowColor: '#A78BFA', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 2 },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  profileAvatar: { width: 52, height: 52, borderRadius: 16, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  profileAvatarText: { fontSize: 24, fontWeight: '800', color: '#FFFFFF' },
  nameRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  profileName: { fontSize: 18, fontWeight: '800', color: colors.text },
  nameInput: { flex: 1, fontSize: 18, fontWeight: '800', color: colors.text, borderBottomWidth: 2, borderBottomColor: colors.primary, paddingBottom: 4 },
  subLabel: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginBottom: 8, marginTop: 4 },
  stampGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  stampItem: { alignItems: 'center', gap: 4 },
  stampBadge: { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  stampText: { fontSize: 14, fontWeight: '800' },
  stampType: { fontSize: 9, color: colors.textLight, fontWeight: '600' },
  dangerBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FFF0F0', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, alignSelf: 'flex-start', marginTop: 4 },
  dangerBtnText: { fontSize: 13, fontWeight: '700', color: '#EF4444' },
  emptyText: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  recurringItem: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, flexDirection: 'row', alignItems: 'center', marginBottom: 8, shadowColor: '#A78BFA', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  recurringInfo: { flex: 1 },
  recurringName: { fontSize: 14, fontWeight: '700', color: colors.text },
  recurringDays: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  deleteBtn: { padding: 6, backgroundColor: '#FFF0F0', borderRadius: 8 },
  aboutRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.divider },
  aboutLabel: { fontSize: 14, color: colors.textSecondary, fontWeight: '500' },
  aboutValue: { fontSize: 14, color: colors.text, fontWeight: '700' },
  imageStampGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  imageStampItem: { position: 'relative' },
  imageStampImg: { width: 56, height: 56, borderRadius: 14 },
  imageStampDelete: { position: 'absolute', top: -6, right: -6 },
});
