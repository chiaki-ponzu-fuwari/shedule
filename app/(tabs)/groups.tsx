import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Modal, TextInput, SafeAreaView, Platform, Alert, ActivityIndicator, Share, Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Haptics } from '../../utils/haptics';
import * as ImagePicker from 'expo-image-picker';
import { compressPickedImageUri } from '../../utils/compressPickedImage';

const hapticImpact = (style = Haptics.ImpactFeedbackStyle.Medium) => {
  if (Platform.OS !== 'web') Haptics.impactAsync(style);
};
const hapticSelect = () => {
  if (Platform.OS !== 'web') Haptics.selectionAsync();
};
const hapticNotify = (type = Haptics.NotificationFeedbackType.Success) => {
  if (Platform.OS !== 'web') Haptics.notificationAsync(type);
};
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGroupStore } from '../../store/groupStore';
import { colors } from '../../constants/colors';
import { Group } from '../../types';
import { GroupDetailSheet } from '../../components/groups/GroupDetailSheet';
import { useTranslation } from '../../constants/i18n';
import { devError } from '../../utils/devLog';

const MEMBER_COLORS = ['#3B82F6', '#34D399', '#F59E0B', '#EF4444', '#A78BFA', '#FB923C', '#EC4899', '#14B8A6'];

const GROUP_COLORS = ['#FF6B9D', '#3B82F6', '#34D399', '#60A5FA', '#FBBF24', '#FB923C'];
const GROUP_EMOJIS = ['🌸', '⭐', '🌿', '🎵', '🏠', '🎮', '🐾', '☕', '🌙', '🎨'];

function isInvalidEmoji(s?: string) {
  const v = (s ?? '').trim();
  return !v || v === '?' || v === '？';
}

function makeInviteUrl(code: string): string {
  return `scheduleshare://join/${code}`;
}

export default function GroupsScreen() {
  const { t, locale } = useTranslation();
  const insets = useSafeAreaInsets();
  const groups = useGroupStore((s) => s.groups);
  const loading = useGroupStore((s) => s.loading);
  const fetchGroups = useGroupStore((s) => s.fetchGroups);
  const createGroup = useGroupStore((s) => s.createGroup);
  const joinGroupByCode = useGroupStore((s) => s.joinGroupByCode);
  const deleteGroup = useGroupStore((s) => s.deleteGroup);
  const setGroupIconUri = useGroupStore((s) => s.setGroupIconUri);
  const myName = useGroupStore((s) => s.myName);
  const myUserId = useGroupStore((s) => s.myUserId);
  const setMyName = useGroupStore((s) => s.setMyName);

  const [createVisible, setCreateVisible] = useState(false);
  const [joinVisible, setJoinVisible] = useState(false);
  const [detailGroupId, setDetailGroupId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [createError, setCreateError] = useState('');
  const [nicknameVisible, setNicknameVisible] = useState(false);
  const [nicknameInput, setNicknameInput] = useState('');
  const [nicknameColor, setNicknameColor] = useState(MEMBER_COLORS[0]);

  // IDからグループを都度取得（無限ループ防止）
  const detailGroup = detailGroupId ? (groups.find((g) => g.id === detailGroupId) ?? null) : null;

  // Create form
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(GROUP_COLORS[0]);
  const [newEmoji, setNewEmoji] = useState(GROUP_EMOJIS[0]);
  const [newIconUri, setNewIconUri] = useState<string | undefined>(undefined);
  const [joinCode, setJoinCode] = useState('');

  useEffect(() => {
    // ニックネーム未設定ならオンボーディングを表示（初回のみ）
    if (!myName || myName === 'わたし') {
      setNicknameInput('');
      setNicknameVisible(true);
    }
  }, []);

  // Auth の userId が入ったあとで一覧取得（Web リロード後の復元と整合）
  useEffect(() => {
    if (!myUserId) return;
    fetchGroups();
  }, [myUserId, fetchGroups]);

  const handleNicknameConfirm = useCallback(() => {
    const name = nicknameInput.trim();
    if (!name) return;
    setMyName(name);
    setNicknameVisible(false);
    hapticNotify();
  }, [nicknameInput, setMyName]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError('');
    hapticImpact();
    try {
      const group = await createGroup(newName.trim(), newColor, newEmoji);
      setCreating(false);
      if (group) {
        if (newIconUri) setGroupIconUri(group.id, newIconUri);
        setNewName('');
        setNewIconUri(undefined);
        setCreateVisible(false);
        hapticNotify();
      }
    } catch (e: any) {
      devError('handleCreate', e?.message ?? String(e));
      setCreating(false);
      const msg = e?.message ?? String(e);
      if (typeof msg === 'string' && msg.includes('group_limit_reached')) {
        setCreateError(t('groups.createLimit', { max: 10 }));
      } else {
        setCreateError(msg);
      }
    }
  };

  const pickGroupIconImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('settings.photoPermissionTitle'), t('settings.photoPermissionBody'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      const uri = await compressPickedImageUri(result.assets[0].uri);
      setNewIconUri(uri);
      hapticNotify();
    }
  };

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    setJoining(true);
    hapticImpact();
    const group = await joinGroupByCode(joinCode);
    setJoining(false);
    if (group) {
      setJoinCode('');
      setJoinVisible(false);
      hapticNotify();
    } else {
      Alert.alert(t('groups.errTitle'), t('groups.codeNotFound'));
    }
  };

  const handleDelete = (group: Group) => {
    hapticImpact();
    const title = t('groups.leaveTitle');
    const message = t('groups.leaveMsg', { name: group.name });
    const runLeave = async () => {
      try {
        await deleteGroup(group.id);
        setDetailGroupId(null);
        hapticNotify();
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (Platform.OS === 'web') {
          window.alert(`${t('groups.errTitle')}\n\n${msg}`);
        } else {
          Alert.alert(t('groups.errTitle'), msg);
        }
      }
    };
    // Expo Web では Alert の複数ボタンが表示されない／タッチと相性が悪いことがある
    if (Platform.OS === 'web') {
      const ok = window.confirm(`${title}\n\n${message}`);
      if (ok) void runLeave();
      return;
    }
    Alert.alert(title, message, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('groups.leaveBtn'), style: 'destructive', onPress: () => void runLeave() },
    ]);
  };

  const shareInvite = async (group: Group) => {
    const url = `scheduleshare://join/${group.inviteCode}`;
    const message = t('groups.inviteMsg', { name: group.name, url, code: group.inviteCode });
    try {
      await Share.share({ message, url });
      hapticNotify();
    } catch {
      await Clipboard.setStringAsync(message);
      hapticNotify();
      Alert.alert(t('groups.copiedTitle'), t('groups.copiedBody', { code: group.inviteCode }));
    }
  };

  return (
    <SafeAreaView style={[styles.container, { paddingTop: Platform.OS === 'android' ? insets.top : 0 }]}>
      {/* Header */}
      <LinearGradient colors={['#DBEAFE', '#EFF6FF']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.header}>
        <Text style={styles.headerTitle}>{t('groups.header')}</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.headerBtn} onPress={() => { fetchGroups({ force: true }); hapticSelect(); }}>
            <Ionicons name="refresh" size={18} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerBtn} onPress={() => setJoinVisible(true)}>
            <Ionicons name="link" size={18} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerBtn} onPress={() => setCreateVisible(true)}>
            <Ionicons name="add" size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </LinearGradient>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {loading && groups.length === 0 ? (
          <View style={styles.emptyState}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : groups.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>👥</Text>
            <Text style={styles.emptyTitle}>{t('groups.emptyTitle')}</Text>
            <Text style={styles.emptyDesc}>{t('groups.emptyDesc')}</Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={() => setCreateVisible(true)}>
              <Text style={styles.emptyBtnText}>{t('groups.create')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.emptyBtn, styles.emptyBtnSecondary]} onPress={() => setJoinVisible(true)}>
              <Text style={[styles.emptyBtnText, styles.emptyBtnTextSecondary]}>{t('groups.joinWithCode')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.groupList}>
            <TouchableOpacity style={styles.joinBanner} onPress={() => { hapticSelect(); setJoinVisible(true); }}>
              <Ionicons name="link-outline" size={16} color={colors.primary} />
              <Text style={styles.joinBannerText}>{t('groups.joinBanner')}</Text>
              <Ionicons name="chevron-forward" size={14} color={colors.textLight} />
            </TouchableOpacity>
            {groups.map((group) => (
              <TouchableOpacity
                key={group.id}
                style={styles.groupCard}
                onPress={() => setDetailGroupId(group.id)}
                activeOpacity={0.85}
              >
                <View style={[styles.groupIcon, { backgroundColor: group.color + '22' }]}>
                  {group.iconUri ? (
                    <Image source={{ uri: group.iconUri }} style={styles.groupIconImage} />
                  ) : (
                    <Text style={styles.groupEmoji}>{isInvalidEmoji(group.emoji) ? '👥' : group.emoji}</Text>
                  )}
                </View>
                <View style={styles.groupInfo}>
                  <Text style={styles.groupName}>{group.name}</Text>
                  <Text style={styles.groupMembers}>
                    {group.members.length}{locale === 'ja' ? '' : ' '}{t('groups.membersUnit')} · {t('groups.code')}: {group.inviteCode}
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
            <Text style={styles.modalTitle}>{t('groups.createTitle')}</Text>
            <Text style={styles.fieldLabel}>{t('groups.groupName')}</Text>
            <TextInput
              style={styles.textInput}
              value={newName}
              onChangeText={setNewName}
              placeholder={t('groups.namePh')}
              placeholderTextColor={colors.textLight}
              autoFocus
            />
            <Text style={styles.fieldLabel}>{t('groups.icon')}</Text>
            <View style={styles.iconRow}>
              <View style={[styles.groupIcon, { backgroundColor: newColor + '22' }]}>
                {newIconUri ? (
                  <Image source={{ uri: newIconUri }} style={styles.groupIconImage} />
                ) : (
                  <Text style={styles.groupEmoji}>{newEmoji}</Text>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <TouchableOpacity style={styles.iconPickBtn} onPress={pickGroupIconImage}>
                  <Ionicons name="image-outline" size={16} color={colors.primary} />
                  <Text style={styles.iconPickBtnText}>{t('groups.addImage')}</Text>
                </TouchableOpacity>
                {newIconUri ? (
                  <TouchableOpacity
                    style={[styles.iconPickBtn, styles.iconPickBtnSecondary]}
                    onPress={() => { setNewIconUri(undefined); hapticSelect(); }}
                  >
                    <Ionicons name="close" size={16} color={colors.textSecondary} />
                    <Text style={[styles.iconPickBtnText, { color: colors.textSecondary }]}>{t('groups.removeImage')}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
            <View style={styles.emojiRow}>
              {GROUP_EMOJIS.map((e) => (
                <TouchableOpacity
                  key={e}
                  style={[styles.emojiBtn, newEmoji === e && styles.emojiBtnActive]}
                  onPress={() => { hapticSelect(); setNewEmoji(e); }}
                >
                  <Text style={styles.emojiText}>{isInvalidEmoji(e) ? '👥' : e}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.fieldLabel}>{t('groups.color')}</Text>
            <View style={styles.colorRow}>
              {GROUP_COLORS.map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[styles.colorDot, { backgroundColor: c }, newColor === c && styles.colorDotSelected]}
                  onPress={() => { hapticSelect(); setNewColor(c); }}
                />
              ))}
            </View>
            {createError ? (
              <Text style={styles.errorText}>{createError}</Text>
            ) : null}
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => { setCreateVisible(false); setCreateError(''); }}>
                <Text style={styles.cancelBtnText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmBtn, (!newName.trim() || creating) && styles.confirmBtnDisabled]}
                onPress={handleCreate}
                disabled={!newName.trim() || creating}
              >
                {creating ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.confirmBtnText}>{t('groups.createBtn')}</Text>
                )}
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
            <Text style={styles.modalTitle}>{t('groups.joinTitle')}</Text>
            <Text style={styles.fieldLabel}>{t('groups.inviteCode')}</Text>
            <TextInput
              style={[styles.textInput, styles.codeInput]}
              value={joinCode}
              onChangeText={(text) => setJoinCode(text.toUpperCase())}
              placeholder="ABC123"
              placeholderTextColor={colors.textLight}
              autoCapitalize="characters"
              maxLength={8}
              autoFocus
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setJoinVisible(false)}>
                <Text style={styles.cancelBtnText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmBtn, (!joinCode.trim() || joining) && styles.confirmBtnDisabled]}
                onPress={handleJoin}
                disabled={!joinCode.trim() || joining}
              >
                {joining ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.confirmBtnText}>{t('groups.joinBtn')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Group Detail Sheet */}
      {detailGroup && (
        <GroupDetailSheet
          group={detailGroup}
          visible={!!detailGroup}
          onClose={() => setDetailGroupId(null)}
          onDelete={handleDelete}
          onShare={shareInvite}
        />
      )}

      {/* ── ニックネーム設定モーダル ── */}
      <Modal transparent animationType="fade" visible={nicknameVisible} onRequestClose={() => {}} statusBarTranslucent>
        <View style={styles.nicknameOverlay}>
          <View style={styles.nicknameCard}>
            <Text style={styles.nicknameEmoji}>👋</Text>
            <Text style={styles.nicknameTitle}>{t('groups.nicknameHi')}</Text>
            <Text style={styles.nicknameDesc}>{t('groups.nicknameDesc')}</Text>

            {/* アバターカラー選択 */}
            <View style={styles.nicknameAvatarPreview}>
              <View style={[styles.nicknameAvatar, { backgroundColor: nicknameColor }]}>
                <Text style={styles.nicknameAvatarText}>
                  {nicknameInput.trim().charAt(0) || '？'}
                </Text>
              </View>
            </View>

            <TextInput
              style={styles.nicknameInput}
              value={nicknameInput}
              onChangeText={setNicknameInput}
              placeholder={t('groups.nicknamePh')}
              placeholderTextColor={colors.textLight}
              maxLength={12}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleNicknameConfirm}
            />

            {/* カラー選択 */}
            <View style={styles.nicknameColorRow}>
              {MEMBER_COLORS.map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[styles.nicknameColorDot, { backgroundColor: c }, nicknameColor === c && styles.nicknameColorDotActive]}
                  onPress={() => { hapticSelect(); setNicknameColor(c); }}
                />
              ))}
            </View>

            <TouchableOpacity
              style={[styles.nicknameBtn, !nicknameInput.trim() && { opacity: 0.4 }]}
              onPress={handleNicknameConfirm}
              disabled={!nicknameInput.trim()}
            >
              <Text style={styles.nicknameBtnText}>{t('groups.nicknameOk')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  groupCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12, shadowColor: '#3B82F6', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.1, shadowRadius: 10, elevation: 3 },
  groupIcon: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  groupEmoji: { fontSize: 26 },
  groupIconImage: { width: 52, height: 52, borderRadius: 16, resizeMode: 'cover' },
  groupInfo: { flex: 1 },
  groupName: { fontSize: 16, fontWeight: '700', color: colors.text },
  groupMembers: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  memberAvatars: { flexDirection: 'row' },
  avatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFFFFF' },
  avatarText: { fontSize: 11, fontWeight: '700', color: '#FFFFFF' },
  // Modal styles
  modalOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingBottom: 40, maxHeight: '90%' },
  modalSheetScroll: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingBottom: 40 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#BFDBFE', alignSelf: 'center', marginTop: 10, marginBottom: 8 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: colors.text, marginBottom: 4, marginTop: 8 },
  fieldLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginTop: 16, marginBottom: 8 },
  textInput: { borderWidth: 2, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.text },
  codeInput: { textAlign: 'center', fontSize: 24, fontWeight: '800', letterSpacing: 6 },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  emojiBtn: { width: 44, height: 44, borderRadius: 12, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  emojiBtnActive: { borderColor: colors.primary, backgroundColor: '#DBEAFE' },
  emojiText: { fontSize: 22 },
  iconRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconPickBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#EFF6FF', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12 },
  iconPickBtnSecondary: { backgroundColor: '#F5EFF5', marginTop: 8 },
  iconPickBtnText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  colorRow: { flexDirection: 'row', gap: 10 },
  colorDot: { width: 36, height: 36, borderRadius: 10 },
  colorDotSelected: { borderWidth: 3, borderColor: colors.text, transform: [{ scale: 1.15 }] },
  modalBtns: { flexDirection: 'row', gap: 10, marginTop: 20 },
  cancelBtn: { flex: 1, backgroundColor: '#F5EFF5', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  cancelBtnText: { fontSize: 15, fontWeight: '600', color: colors.textSecondary },
  confirmBtn: { flex: 1, backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14, alignItems: 'center', shadowColor: colors.primary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 3 },
  confirmBtnDisabled: { backgroundColor: colors.textLight, shadowOpacity: 0 },
  confirmBtnText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
  errorText: { fontSize: 13, color: '#EF4444', fontWeight: '600', marginTop: 8, textAlign: 'center' },
  joinBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#EFF6FF', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: colors.primaryLight },
  joinBannerText: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.primary },

  // ニックネームモーダル
  nicknameOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.55)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  nicknameCard: { backgroundColor: '#FFFFFF', borderRadius: 28, padding: 28, alignItems: 'center', width: '100%', gap: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 20, elevation: 10 },
  nicknameEmoji: { fontSize: 48 },
  nicknameTitle: { fontSize: 22, fontWeight: '800', color: colors.text },
  nicknameDesc: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', lineHeight: 18 },
  nicknameAvatarPreview: { marginVertical: 4 },
  nicknameAvatar: { width: 64, height: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  nicknameAvatarText: { fontSize: 28, fontWeight: '800', color: '#FFFFFF' },
  nicknameInput: { width: '100%', borderWidth: 2, borderColor: colors.primaryLight, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center', backgroundColor: '#F8FAFF' },
  nicknameColorRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap', justifyContent: 'center' },
  nicknameColorDot: { width: 30, height: 30, borderRadius: 15 },
  nicknameColorDotActive: { borderWidth: 3, borderColor: colors.text, transform: [{ scale: 1.15 }] },
  nicknameBtn: { width: '100%', backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14, alignItems: 'center', shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  nicknameBtnText: { fontSize: 16, fontWeight: '800', color: '#FFFFFF' },
});
