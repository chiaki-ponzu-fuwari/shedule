import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Modal, TextInput, SafeAreaView, Platform, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGroupStore } from '../../store/groupStore';
import { colors } from '../../constants/colors';
import { Group } from '../../types';

const GROUP_COLORS = ['#FF6B9D', '#A78BFA', '#34D399', '#60A5FA', '#FBBF24', '#FB923C'];
const GROUP_EMOJIS = ['🌸', '⭐', '🌿', '🎵', '🏠', '🎮', '🐾', '☕', '🌙', '🎨'];

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export default function GroupsScreen() {
  const insets = useSafeAreaInsets();
  const groups = useGroupStore((s) => s.groups);
  const addGroup = useGroupStore((s) => s.addGroup);
  const removeGroup = useGroupStore((s) => s.removeGroup);
  const updateMemo = useGroupStore((s) => s.updateMemo);
  const myName = useGroupStore((s) => s.myName);

  const [createVisible, setCreateVisible] = useState(false);
  const [joinVisible, setJoinVisible] = useState(false);
  const [detailGroup, setDetailGroup] = useState<Group | null>(null);
  const [memoEdit, setMemoEdit] = useState('');

  // Create form
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(GROUP_COLORS[0]);
  const [newEmoji, setNewEmoji] = useState(GROUP_EMOJIS[0]);
  const [joinCode, setJoinCode] = useState('');

  const handleCreate = () => {
    if (!newName.trim()) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const group: Group = {
      id: `group_${Date.now()}`,
      name: newName.trim(),
      color: newColor,
      emoji: newEmoji,
      inviteCode: generateCode(),
      members: [{ id: 'me', name: myName, color: newColor, isOwner: true }],
      sharedMemo: '',
      createdAt: new Date().toISOString(),
    };
    addGroup(group);
    setNewName('');
    setCreateVisible(false);
  };

  const handleJoin = () => {
    if (!joinCode.trim()) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // In a real app, this would hit the backend. For now, create a demo group.
    const group: Group = {
      id: `group_${Date.now()}`,
      name: `グループ（${joinCode.toUpperCase()}）`,
      color: GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)],
      emoji: GROUP_EMOJIS[Math.floor(Math.random() * GROUP_EMOJIS.length)],
      inviteCode: joinCode.toUpperCase(),
      members: [
        { id: 'me', name: myName, color: colors.primary },
        { id: 'host', name: 'ホスト', color: '#A78BFA', isOwner: true },
      ],
      sharedMemo: '',
      createdAt: new Date().toISOString(),
    };
    addGroup(group);
    setJoinCode('');
    setJoinVisible(false);
  };

  const copyCode = async (code: string) => {
    await Clipboard.setStringAsync(code);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('コピーしました', `招待コード「${code}」をコピーしました`);
  };

  return (
    <SafeAreaView style={[styles.container, { paddingTop: Platform.OS === 'android' ? insets.top : 0 }]}>
      {/* Header */}
      <LinearGradient colors={['#FFE4F0', '#EDE9FE']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.header}>
        <Text style={styles.headerTitle}>グループ共有</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.headerBtn} onPress={() => setJoinVisible(true)}>
            <Ionicons name="link" size={18} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerBtn} onPress={() => setCreateVisible(true)}>
            <Ionicons name="add" size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </LinearGradient>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {groups.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>👥</Text>
            <Text style={styles.emptyTitle}>グループがありません</Text>
            <Text style={styles.emptyDesc}>友人・家族・職場でカレンダーを共有しましょう</Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={() => setCreateVisible(true)}>
              <Text style={styles.emptyBtnText}>＋ グループを作る</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.emptyBtn, styles.emptyBtnSecondary]} onPress={() => setJoinVisible(true)}>
              <Text style={[styles.emptyBtnText, styles.emptyBtnTextSecondary]}>招待コードで参加</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.groupList}>
            {groups.map((group) => (
              <TouchableOpacity
                key={group.id}
                style={styles.groupCard}
                onPress={() => { setDetailGroup(group); setMemoEdit(group.sharedMemo ?? ''); }}
                activeOpacity={0.85}
              >
                <View style={[styles.groupIcon, { backgroundColor: group.color + '22' }]}>
                  <Text style={styles.groupEmoji}>{group.emoji}</Text>
                </View>
                <View style={styles.groupInfo}>
                  <Text style={styles.groupName}>{group.name}</Text>
                  <Text style={styles.groupMembers}>
                    {group.members.length}人 · コード: {group.inviteCode}
                  </Text>
                </View>
                <View style={styles.memberAvatars}>
                  {group.members.slice(0, 3).map((m, i) => (
                    <View
                      key={m.id}
                      style={[
                        styles.avatar,
                        { backgroundColor: m.color, marginLeft: i === 0 ? 0 : -8, zIndex: 3 - i },
                      ]}
                    >
                      <Text style={styles.avatarText}>{m.name.charAt(0)}</Text>
                    </View>
                  ))}
                  {group.members.length > 3 && (
                    <View style={[styles.avatar, { backgroundColor: colors.textLight, marginLeft: -8 }]}>
                      <Text style={styles.avatarText}>+{group.members.length - 3}</Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Create Modal */}
      <Modal transparent animationType="slide" visible={createVisible} onRequestClose={() => setCreateVisible(false)} statusBarTranslucent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.handle} />
            <Text style={styles.modalTitle}>グループを作成</Text>
            <Text style={styles.fieldLabel}>グループ名</Text>
            <TextInput
              style={styles.textInput}
              value={newName}
              onChangeText={setNewName}
              placeholder="例: 看護師シフト班、家族グループ"
              placeholderTextColor={colors.textLight}
              autoFocus
            />
            <Text style={styles.fieldLabel}>アイコン</Text>
            <View style={styles.emojiRow}>
              {GROUP_EMOJIS.map((e) => (
                <TouchableOpacity
                  key={e}
                  style={[styles.emojiBtn, newEmoji === e && styles.emojiBtnActive]}
                  onPress={() => { Haptics.selectionAsync(); setNewEmoji(e); }}
                >
                  <Text style={styles.emojiText}>{e}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.fieldLabel}>カラー</Text>
            <View style={styles.colorRow}>
              {GROUP_COLORS.map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[styles.colorDot, { backgroundColor: c }, newColor === c && styles.colorDotSelected]}
                  onPress={() => { Haptics.selectionAsync(); setNewColor(c); }}
                />
              ))}
            </View>
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setCreateVisible(false)}>
                <Text style={styles.cancelBtnText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmBtn, !newName.trim() && styles.confirmBtnDisabled]}
                onPress={handleCreate}
                disabled={!newName.trim()}
              >
                <Text style={styles.confirmBtnText}>作成する</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Join Modal */}
      <Modal transparent animationType="slide" visible={joinVisible} onRequestClose={() => setJoinVisible(false)} statusBarTranslucent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.handle} />
            <Text style={styles.modalTitle}>招待コードで参加</Text>
            <Text style={styles.fieldLabel}>招待コード</Text>
            <TextInput
              style={[styles.textInput, styles.codeInput]}
              value={joinCode}
              onChangeText={(t) => setJoinCode(t.toUpperCase())}
              placeholder="ABC123"
              placeholderTextColor={colors.textLight}
              autoCapitalize="characters"
              maxLength={8}
              autoFocus
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setJoinVisible(false)}>
                <Text style={styles.cancelBtnText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmBtn, !joinCode.trim() && styles.confirmBtnDisabled]}
                onPress={handleJoin}
                disabled={!joinCode.trim()}
              >
                <Text style={styles.confirmBtnText}>参加する</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Group Detail Modal */}
      {detailGroup && (
        <Modal transparent animationType="slide" visible={!!detailGroup} onRequestClose={() => setDetailGroup(null)} statusBarTranslucent>
          <View style={styles.modalOverlay}>
            <View style={styles.modalSheet}>
              <View style={styles.handle} />
              <View style={styles.detailHeader}>
                <Text style={styles.detailEmoji}>{detailGroup.emoji}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.modalTitle}>{detailGroup.name}</Text>
                  <Text style={styles.groupMembers}>{detailGroup.members.length}人のメンバー</Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    Alert.alert('グループを削除', `「${detailGroup.name}」を削除しますか？`, [
                      { text: 'キャンセル', style: 'cancel' },
                      { text: '削除', style: 'destructive', onPress: () => { removeGroup(detailGroup.id); setDetailGroup(null); } },
                    ]);
                  }}
                >
                  <Ionicons name="trash-outline" size={20} color="#EF4444" />
                </TouchableOpacity>
              </View>

              {/* Invite code */}
              <TouchableOpacity style={styles.inviteCodeRow} onPress={() => copyCode(detailGroup.inviteCode)}>
                <Text style={styles.inviteCodeLabel}>招待コード</Text>
                <Text style={styles.inviteCode}>{detailGroup.inviteCode}</Text>
                <Ionicons name="copy-outline" size={16} color={colors.primary} />
              </TouchableOpacity>

              {/* Members */}
              <Text style={styles.fieldLabel}>メンバー</Text>
              {detailGroup.members.map((m) => (
                <View key={m.id} style={styles.memberRow}>
                  <View style={[styles.avatar, { backgroundColor: m.color }]}>
                    <Text style={styles.avatarText}>{m.name.charAt(0)}</Text>
                  </View>
                  <Text style={styles.memberName}>{m.name}</Text>
                  {m.isOwner && <View style={styles.ownerBadge}><Text style={styles.ownerText}>オーナー</Text></View>}
                </View>
              ))}

              {/* Shared memo */}
              <Text style={styles.fieldLabel}>共有メモ</Text>
              <TextInput
                style={styles.memoInput}
                value={memoEdit}
                onChangeText={setMemoEdit}
                onBlur={() => updateMemo(detailGroup.id, memoEdit)}
                placeholder="グループ全員で編集できるメモ..."
                placeholderTextColor={colors.textLight}
                multiline
                textAlignVertical="top"
              />

              <TouchableOpacity style={styles.confirmBtn} onPress={() => setDetailGroup(null)}>
                <Text style={styles.confirmBtnText}>閉じる</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14 },
  headerTitle: { fontSize: 20, fontWeight: '800', color: colors.text },
  headerActions: { flexDirection: 'row', gap: 8 },
  headerBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.7)', alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  emptyState: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 40 },
  emptyEmoji: { fontSize: 64, marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: colors.text, marginBottom: 8 },
  emptyDesc: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  emptyBtn: { backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 32, marginBottom: 10, width: '100%', alignItems: 'center', shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 4 },
  emptyBtnSecondary: { backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: colors.primary, shadowOpacity: 0 },
  emptyBtnText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
  emptyBtnTextSecondary: { color: colors.primary },
  groupList: { padding: 16, gap: 12 },
  groupCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12, shadowColor: '#A78BFA', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.1, shadowRadius: 10, elevation: 3 },
  groupIcon: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  groupEmoji: { fontSize: 26 },
  groupInfo: { flex: 1 },
  groupName: { fontSize: 16, fontWeight: '700', color: colors.text },
  groupMembers: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  memberAvatars: { flexDirection: 'row' },
  avatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFFFFF' },
  avatarText: { fontSize: 11, fontWeight: '700', color: '#FFFFFF' },
  // Modal styles
  modalOverlay: { flex: 1, backgroundColor: 'rgba(45,27,105,0.45)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingBottom: 40, maxHeight: '90%' },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#E0D0F0', alignSelf: 'center', marginTop: 10, marginBottom: 8 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: colors.text, marginBottom: 4, marginTop: 8 },
  fieldLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginTop: 16, marginBottom: 8 },
  textInput: { borderWidth: 2, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.text },
  codeInput: { textAlign: 'center', fontSize: 24, fontWeight: '800', letterSpacing: 6 },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  emojiBtn: { width: 44, height: 44, borderRadius: 12, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  emojiBtnActive: { borderColor: colors.primary, backgroundColor: '#FFE4F0' },
  emojiText: { fontSize: 22 },
  colorRow: { flexDirection: 'row', gap: 10 },
  colorDot: { width: 36, height: 36, borderRadius: 10 },
  colorDotSelected: { borderWidth: 3, borderColor: colors.text, transform: [{ scale: 1.15 }] },
  modalBtns: { flexDirection: 'row', gap: 10, marginTop: 20 },
  cancelBtn: { flex: 1, backgroundColor: '#F5EFF5', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  cancelBtnText: { fontSize: 15, fontWeight: '600', color: colors.textSecondary },
  confirmBtn: { flex: 1, backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14, alignItems: 'center', shadowColor: colors.primary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 3 },
  confirmBtnDisabled: { backgroundColor: colors.textLight, shadowOpacity: 0 },
  confirmBtnText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  detailEmoji: { fontSize: 36 },
  inviteCodeRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5EFF5', borderRadius: 12, padding: 14, gap: 8, marginTop: 8 },
  inviteCodeLabel: { fontSize: 12, fontWeight: '600', color: colors.textSecondary, flex: 1 },
  inviteCode: { fontSize: 18, fontWeight: '800', color: colors.primary, letterSpacing: 3 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  memberName: { fontSize: 14, fontWeight: '600', color: colors.text, flex: 1 },
  ownerBadge: { backgroundColor: '#FFE4F0', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  ownerText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  memoInput: { borderWidth: 2, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: colors.text, minHeight: 80, textAlignVertical: 'top', marginBottom: 16 },
});
