import React, { useState, useEffect } from 'react';
import {
  View, Text, Modal, TouchableWithoutFeedback, TouchableOpacity,
  StyleSheet, ScrollView, TextInput, ActivityIndicator, Platform, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useGroupStore } from '../../store/groupStore';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { colors } from '../../constants/colors';
import { Group, GroupSharingSettings, SharedEntry } from '../../types';
import { formatFullDate } from '../../utils/dateUtils';

const { height: SCREEN_H } = Dimensions.get('window');

const hapticSelect = () => { if (Platform.OS !== 'web') Haptics.selectionAsync(); };
const hapticNotify = () => { if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); };

type Tab = 'info' | 'schedule';

interface Props {
  group: Group;
  visible: boolean;
  onClose: () => void;
  onDelete: (group: Group) => void;
  onShare: (group: Group) => void;
}

export function GroupDetailSheet({ group, visible, onClose, onDelete, onShare }: Props) {
  const [tab, setTab] = useState<Tab>('info');
  const [memoEdit, setMemoEdit] = useState(group.sharedMemo ?? '');
  const [syncing, setSyncing] = useState(false);

  const updateSharedMemo = useGroupStore((s) => s.updateSharedMemo);
  const sharingSettings = useGroupStore((s) => s.sharingSettings[group.id] ?? { shareMain: true, shareMini: false, shareNotes: false });
  const setSharingSettings = useGroupStore((s) => s.setSharingSettings);
  const syncMySchedule = useGroupStore((s) => s.syncMySchedule);
  const fetchGroupSchedules = useGroupStore((s) => s.fetchGroupSchedules);
  const sharedEntries = useGroupStore((s) => s.sharedEntries[group.id] ?? []);

  const entries = useCalendarStore((s) => s.entries);
  const getStamp = useStampStore((s) => s.getStamp);

  useEffect(() => {
    if (!visible) return;
    setMemoEdit(group.sharedMemo ?? '');
  }, [visible]);

  useEffect(() => {
    if (visible && tab === 'schedule') {
      fetchGroupSchedules(group.id);
    }
  }, [visible, tab]);

  const toggleSetting = (key: keyof GroupSharingSettings) => {
    hapticSelect();
    setSharingSettings(group.id, { ...sharingSettings, [key]: !sharingSettings[key] });
  };

  const handleSync = async () => {
    setSyncing(true);
    hapticSelect();

    const syncData = Object.entries(entries)
      .filter(([, entry]) => {
        if (sharingSettings.shareMain && entry.mainStampId) return true;
        if (sharingSettings.shareMini && (entry.miniStamps?.left || entry.miniStamps?.right)) return true;
        if (sharingSettings.shareNotes && (entry.notes || (entry.noteItems && entry.noteItems.length > 0))) return true;
        return false;
      })
      .map(([date, entry]) => {
        const mainStamp = sharingSettings.shareMain && entry.mainStampId ? getStamp(entry.mainStampId) : undefined;
        const leftMini = sharingSettings.shareMini && entry.miniStamps?.left ? getStamp(entry.miniStamps.left) : undefined;
        const rightMini = sharingSettings.shareMini && entry.miniStamps?.right ? getStamp(entry.miniStamps.right) : undefined;
        const notesText = sharingSettings.shareNotes
          ? (entry.noteItems?.join(' / ') ?? entry.notes ?? undefined)
          : undefined;
        return {
          date,
          mainStampText: mainStamp?.text,
          mainStampBg: mainStamp?.bgColor,
          mainStampTextColor: mainStamp?.textColor,
          miniLeftText: leftMini?.text,
          miniLeftBg: leftMini?.bgColor,
          miniRightText: rightMini?.text,
          miniRightBg: rightMini?.bgColor,
          notes: notesText,
        };
      });

    await syncMySchedule(group.id, syncData);
    await fetchGroupSchedules(group.id);
    setSyncing(false);
    hapticNotify();
  };

  // 日付ごとにグループ化
  const entriesByDate = sharedEntries.reduce<Record<string, SharedEntry[]>>((acc, e) => {
    if (!acc[e.date]) acc[e.date] = [];
    acc[e.date].push(e);
    return acc;
  }, {});
  const sortedDates = Object.keys(entriesByDate).sort();

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose} statusBarTranslucent>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback onPress={() => {}}>
            <View style={styles.sheet}>
              <View style={styles.handle} />

              {/* ヘッダー */}
              <View style={styles.detailHeader}>
                <Text style={styles.detailEmoji}>{group.emoji}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.modalTitle}>{group.name}</Text>
                  <Text style={styles.subText}>{group.members.length}人のメンバー</Text>
                </View>
                <TouchableOpacity onPress={() => onDelete(group)}>
                  <Ionicons name="exit-outline" size={22} color="#EF4444" />
                </TouchableOpacity>
              </View>

              {/* タブ */}
              <View style={styles.tabRow}>
                {(['info', 'schedule'] as Tab[]).map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.tab, tab === t && styles.tabActive]}
                    onPress={() => { hapticSelect(); setTab(t); }}
                  >
                    <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                      {t === 'info' ? 'グループ情報' : 'スケジュール'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always">
                {tab === 'info' ? (
                  <View>
                    {/* 招待コード */}
                    <View style={styles.inviteCodeRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.inviteCodeLabel}>招待コード</Text>
                        <Text style={styles.inviteCode}>{group.inviteCode}</Text>
                      </View>
                      <TouchableOpacity style={styles.shareBtn} onPress={() => onShare(group)}>
                        <Ionicons name="share-outline" size={18} color="#FFFFFF" />
                        <Text style={styles.shareBtnText}>招待を共有</Text>
                      </TouchableOpacity>
                    </View>

                    {/* メンバー */}
                    <Text style={styles.fieldLabel}>メンバー</Text>
                    {group.members.map((m) => (
                      <View key={m.id} style={styles.memberRow}>
                        <View style={[styles.avatar, { backgroundColor: m.color }]}>
                          <Text style={styles.avatarText}>{m.name.charAt(0)}</Text>
                        </View>
                        <Text style={styles.memberName}>{m.name}</Text>
                        {m.isOwner && <View style={styles.ownerBadge}><Text style={styles.ownerText}>オーナー</Text></View>}
                      </View>
                    ))}

                    {/* 共有メモ */}
                    <Text style={styles.fieldLabel}>共有メモ</Text>
                    <TextInput
                      style={styles.memoInput}
                      value={memoEdit}
                      onChangeText={setMemoEdit}
                      onBlur={() => updateSharedMemo(group.id, memoEdit)}
                      placeholder="グループ全員で編集できるメモ..."
                      placeholderTextColor={colors.textLight}
                      multiline
                      textAlignVertical="top"
                    />
                  </View>
                ) : (
                  <View>
                    {/* 共有範囲設定 */}
                    <Text style={styles.fieldLabel}>共有する範囲（自分）</Text>
                    <View style={styles.settingsCard}>
                      {[
                        { key: 'shareMain' as const, label: 'メインスタンプ', icon: '🏷️' },
                        { key: 'shareMini' as const, label: 'ミニスタンプ', icon: '🔖' },
                        { key: 'shareNotes' as const, label: 'メモ・予定', icon: '📝' },
                      ].map(({ key, label, icon }, idx, arr) => (
                        <TouchableOpacity
                          key={key}
                          style={[styles.settingRow, idx < arr.length - 1 && styles.settingRowBorder]}
                          onPress={() => toggleSetting(key)}
                        >
                          <Text style={styles.settingIcon}>{icon}</Text>
                          <Text style={styles.settingLabel}>{label}</Text>
                          <View style={[styles.toggle, sharingSettings[key] && styles.toggleOn]}>
                            <View style={[styles.toggleThumb, sharingSettings[key] && styles.toggleThumbOn]} />
                          </View>
                        </TouchableOpacity>
                      ))}
                    </View>

                    {/* 同期ボタン */}
                    <TouchableOpacity
                      style={[styles.syncBtn, syncing && { opacity: 0.6 }]}
                      onPress={handleSync}
                      disabled={syncing}
                    >
                      {syncing ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <>
                          <Ionicons name="cloud-upload-outline" size={18} color="#FFFFFF" />
                          <Text style={styles.syncBtnText}>スケジュールを同期する</Text>
                        </>
                      )}
                    </TouchableOpacity>

                    {/* メンバーのスケジュール */}
                    <Text style={styles.fieldLabel}>メンバーのスケジュール</Text>
                    {sortedDates.length === 0 ? (
                      <View style={styles.emptySchedule}>
                        <Text style={styles.emptyText}>まだ共有スケジュールはありません</Text>
                        <Text style={styles.emptySubText}>「同期する」を押して自分のスケジュールを共有しましょう</Text>
                      </View>
                    ) : (
                      sortedDates.map((date) => (
                        <View key={date} style={styles.dateCard}>
                          <Text style={styles.dateLabel}>{formatFullDate(date)}</Text>
                          <View style={styles.memberEntries}>
                            {entriesByDate[date].map((e) => (
                              <View key={e.userId} style={styles.memberEntryRow}>
                                <View style={[styles.memberDot, { backgroundColor: e.userColor }]}>
                                  <Text style={styles.memberDotText}>{e.userName.charAt(0)}</Text>
                                </View>
                                <View style={styles.stampChips}>
                                  {e.miniLeftText && (
                                    <View style={[styles.miniChip, { backgroundColor: e.miniLeftBg ?? '#EDE9FE' }]}>
                                      <Text style={styles.miniChipText}>{e.miniLeftText}</Text>
                                    </View>
                                  )}
                                  {e.miniRightText && (
                                    <View style={[styles.miniChip, { backgroundColor: e.miniRightBg ?? '#EDE9FE' }]}>
                                      <Text style={styles.miniChipText}>{e.miniRightText}</Text>
                                    </View>
                                  )}
                                  {e.mainStampText && (
                                    <View style={[styles.mainChip, { backgroundColor: e.mainStampBg ?? '#FFE4F0' }]}>
                                      <Text style={[styles.mainChipText, { color: e.mainStampTextColor ?? colors.primary }]}>
                                        {e.mainStampText}
                                      </Text>
                                    </View>
                                  )}
                                  {e.notes && (
                                    <View style={styles.noteChip}>
                                      <Ionicons name="document-text-outline" size={10} color={colors.textSecondary} />
                                      <Text style={styles.noteChipText} numberOfLines={1}>{e.notes}</Text>
                                    </View>
                                  )}
                                </View>
                              </View>
                            ))}
                          </View>
                        </View>
                      ))
                    )}
                    <View style={{ height: 8 }} />
                  </View>
                )}
                <View style={{ height: 16 }} />
              </ScrollView>

              <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
                <Text style={styles.closeBtnText}>閉じる</Text>
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(45,27,105,0.45)', justifyContent: 'flex-end' },
  sheet: {
    height: SCREEN_H * 0.88,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#E0D0F0', alignSelf: 'center', marginTop: 10, marginBottom: 10 },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  detailEmoji: { fontSize: 36 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  subText: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },

  tabRow: { flexDirection: 'row', backgroundColor: '#F5EFF5', borderRadius: 12, padding: 3, marginBottom: 14 },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center' },
  tabActive: { backgroundColor: '#FFFFFF', shadowColor: '#A78BFA', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 4, elevation: 2 },
  tabText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  tabTextActive: { color: colors.primary, fontWeight: '800' },

  scroll: { flex: 1 },
  fieldLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginTop: 14, marginBottom: 8 },

  inviteCodeRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5EFF5', borderRadius: 12, padding: 14, gap: 12 },
  inviteCodeLabel: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  inviteCode: { fontSize: 20, fontWeight: '800', color: colors.primary, letterSpacing: 3 },
  shareBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  shareBtnText: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },

  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  memberName: { fontSize: 14, fontWeight: '600', color: colors.text, flex: 1 },
  ownerBadge: { backgroundColor: '#FFE4F0', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  ownerText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  avatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFFFFF' },
  avatarText: { fontSize: 11, fontWeight: '700', color: '#FFFFFF' },
  memoInput: { borderWidth: 2, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: colors.text, minHeight: 80, textAlignVertical: 'top' },

  // 共有設定
  settingsCard: { backgroundColor: '#F8F4FC', borderRadius: 16, overflow: 'hidden' },
  settingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, gap: 10 },
  settingRowBorder: { borderBottomWidth: 1, borderBottomColor: '#EDE9FE' },
  settingIcon: { fontSize: 18 },
  settingLabel: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text },
  toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: '#DDD5EE', justifyContent: 'center', paddingHorizontal: 2 },
  toggleOn: { backgroundColor: colors.primary },
  toggleThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.2, shadowRadius: 2, elevation: 2 },
  toggleThumbOn: { alignSelf: 'flex-end' },

  syncBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14, marginTop: 12, shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  syncBtnText: { fontSize: 15, fontWeight: '800', color: '#FFFFFF' },

  emptySchedule: { backgroundColor: '#F8F4FC', borderRadius: 16, padding: 24, alignItems: 'center', gap: 8 },
  emptyText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary, textAlign: 'center' },
  emptySubText: { fontSize: 12, color: colors.textLight, textAlign: 'center', lineHeight: 18 },

  dateCard: { backgroundColor: '#F8F4FC', borderRadius: 14, padding: 12, marginBottom: 10 },
  dateLabel: { fontSize: 12, fontWeight: '800', color: colors.primary, marginBottom: 8 },
  memberEntries: { gap: 8 },
  memberEntryRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  memberDot: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  memberDotText: { fontSize: 11, fontWeight: '700', color: '#FFFFFF' },
  stampChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, flex: 1 },
  miniChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  miniChipText: { fontSize: 10, fontWeight: '700', color: colors.text },
  mainChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  mainChipText: { fontSize: 12, fontWeight: '800' },
  noteChip: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#EDE9FE', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, maxWidth: 150 },
  noteChipText: { fontSize: 10, color: colors.textSecondary, flexShrink: 1 },

  closeBtn: { backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 10, shadowColor: colors.primary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 3 },
  closeBtnText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});
