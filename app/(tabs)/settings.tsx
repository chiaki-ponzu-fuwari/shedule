import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, SafeAreaView, Platform, Alert, Switch, Image, Modal as RNModal, ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Haptics } from '../../utils/haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { useStampStore } from '../../store/stampStore';
import { useGroupStore } from '../../store/groupStore';
import { useCalendarStore } from '../../store/calendarStore';
import { useGoogleAuthStore } from '../../store/googleAuthStore';
import { colors } from '../../constants/colors';
import { Stamp } from '../../types';
import { AddStampModal } from '../../components/modals/AddStampModal';
import { RecurringModal } from '../../components/modals/RecurringModal';
import { BirthdayModal } from '../../components/modals/BirthdayModal';
import { useGoogleAuth } from '../../hooks/useGoogleAuth';
import { runGoogleCalendarSync, GOOGLE_SYNC_NEEDS_LOGIN } from '../../utils/runGoogleCalendarSync';
import { compressPickedImageUri } from '../../utils/compressPickedImage';
import { useGoogleSyncStore } from '../../store/googleSyncStore';
import { useTranslation, dateLocaleTag } from '../../constants/i18n';

export default function SettingsScreen() {
  const { t, locale, setLocale } = useTranslation();
  const insets = useSafeAreaInsets();
  const stamps = useStampStore((s) => s.stamps);
  const removeStamp = useStampStore((s) => s.removeStamp);
  const toggleEnabled = useStampStore((s) => s.toggleEnabled);
  const resetStamps = useStampStore((s) => s.resetToDefaults);
  const imageStamps = useStampStore((s) => s.imageStamps)();
  const addImageStamp = useStampStore((s) => s.addImageStamp);
  const myName = useGroupStore((s) => s.myName);
  const setMyName = useGroupStore((s) => s.setMyName);
  const recurringSchedules = useCalendarStore((s) => s.recurringSchedules);
  const removeRecurring = useCalendarStore((s) => s.removeRecurring);
  const specialDates = useCalendarStore((s) => s.specialDates);
  const removeSpecialDate = useCalendarStore((s) => s.removeSpecialDate);
  const weekStartDay = useCalendarStore((s) => s.weekStartDay);
  const setWeekStartDay = useCalendarStore((s) => s.setWeekStartDay);

  const [addStampVisible, setAddStampVisible] = useState(false);
  const [editingStamp, setEditingStamp] = useState<typeof stamps[0] | undefined>(undefined);
  const [recurringVisible, setRecurringVisible] = useState(false);
  const [recurringListVisible, setRecurringListVisible] = useState(false);
  const [birthdayVisible, setBirthdayVisible] = useState(false);
  const [specialListVisible, setSpecialListVisible] = useState(false);
  const [specialListTab, setSpecialListTab] = useState<'birthday' | 'anniversary' | 'other'>('birthday');
  const [nameEdit, setNameEdit] = useState(myName);
  const [nameEditing, setNameEditing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [googleSyncErrorText, setGoogleSyncErrorText] = useState<string | null>(null);

  const { handleSignIn, handleSignOut, isSignedIn, redirectUri, clientId, request: googleAuthRequest } = useGoogleAuth();

  const webAlertSimple = (title: string, body?: string) => {
    const msg = body !== undefined ? `${title}\n\n${body}` : title;
    if (Platform.OS === 'web' && typeof globalThis !== 'undefined') {
      (globalThis as unknown as { alert?: (m?: string) => void }).alert?.(msg);
    } else {
      Alert.alert(title, body);
    }
  };

  const confirmGoogleDisconnect = (onConfirm: () => void | Promise<void>) => {
    if (Platform.OS === 'web') {
      const ok =
        typeof globalThis !== 'undefined' &&
        (globalThis as unknown as { confirm?: (m?: string) => boolean }).confirm?.(
          t('settings.googleDisconnectConfirm')
        );
      if (ok) void Promise.resolve(onConfirm());
      return;
    }
    Alert.alert(t('settings.googleLogoutTitle'), t('settings.googleDisconnectConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('settings.googleLogoutBtn'), style: 'destructive', onPress: () => void onConfirm() },
    ]);
  };
  const userEmail = useGoogleAuthStore((s) => s.userEmail);
  const userName = useGoogleAuthStore((s) => s.userName);
  const googleSyncMode = useGoogleSyncStore((s) => s.mode);
  const setGoogleSyncMode = useGoogleSyncStore((s) => s.setMode);
  const lastSyncedAt = useGoogleSyncStore((s) => s.lastSyncedAt);

  const handleGoogleSync = useCallback(async () => {
    setSyncing(true);
    setGoogleSyncErrorText(null);
    try {
      const result = await runGoogleCalendarSync({ silent: false });
      if (!result.ok) {
        if (result.error === GOOGLE_SYNC_NEEDS_LOGIN) {
          const body = t('sync.needLoginBody');
          if (Platform.OS === 'web') webAlertSimple(t('sync.needLoginTitle'), body);
          else Alert.alert(t('sync.needLoginTitle'), body);
          return;
        }
        if (result.needsReauth) {
          setGoogleSyncErrorText(result.error);
          if (Platform.OS === 'web') webAlertSimple(t('sync.reauthTitle'), result.error);
          else Alert.alert(t('sync.reauthTitle'), result.error);
          return;
        }
        const s = result.error;
        setGoogleSyncErrorText(s);
        if (s.includes('status=403') || s.includes(' 403')) {
          const longMsg = t('sync.error403Body', { detail: s });
          if (Platform.OS === 'web') webAlertSimple(t('sync.error403Title'), longMsg);
          else Alert.alert(t('sync.error403Title'), longMsg);
        } else {
          if (Platform.OS === 'web') webAlertSimple(t('sync.errorTitle'), s);
          else Alert.alert(t('sync.errorTitle'), s);
        }
        return;
      }
      const timeStr = new Date(result.syncedAtIso).toLocaleString(dateLocaleTag(locale));
      const doneMsg = t('sync.doneBody', {
        time: timeStr,
        imported: result.imported,
        updated: result.fromGoogleUpdated,
        removed: result.fromGoogleRemoved,
        created: result.exportedCreated,
        exported: result.exportedUpdated,
        skipped: result.exportedSkipped,
      });
      if (Platform.OS === 'web') webAlertSimple(t('sync.doneTitle'), doneMsg);
      else Alert.alert(t('sync.doneTitle'), doneMsg);
    } finally {
      setSyncing(false);
    }
  }, [t, locale]);

  const mainStamps = stamps.filter((s) => s.isMain !== false);
  const miniStamps = stamps.filter((s) => s.isMain === false);

  const openEdit = (stamp: typeof stamps[0]) => {
    setEditingStamp(stamp);
    setAddStampVisible(true);
  };

  const handleAddImageStamp = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('settings.photoPermissionTitle'), t('settings.photoPermissionBody'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      const uri = await compressPickedImageUri(result.assets[0].uri);
      addImageStamp(uri);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { paddingTop: Platform.OS === 'android' ? insets.top : 0 }]}>
      <LinearGradient colors={['#DBEAFE', '#EFF6FF']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>{t('settings.title')}</Text>
          <View style={styles.langRow}>
            <TouchableOpacity
              style={[styles.langChip, locale === 'ja' && styles.langChipActive]}
              onPress={() => { Haptics.selectionAsync(); setLocale('ja'); }}
              accessibilityRole="button"
              accessibilityLabel="日本語"
            >
              <Text style={[styles.langChipText, locale === 'ja' && styles.langChipTextActive]}>JA</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.langChip, locale === 'en' && styles.langChipActive]}
              onPress={() => { Haptics.selectionAsync(); setLocale('en'); }}
              accessibilityRole="button"
              accessibilityLabel="English"
            >
              <Text style={[styles.langChipText, locale === 'en' && styles.langChipTextActive]}>EN</Text>
            </TouchableOpacity>
          </View>
        </View>
      </LinearGradient>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Profile */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.profile')}</Text>
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

        {/* Calendar Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.calendar')}</Text>
          <View style={styles.card}>
            <Text style={[styles.subLabel, { marginTop: 0, marginBottom: 12 }]}>{t('settings.weekStart')}</Text>
            <View style={styles.weekStartRow}>
              {([{ labelKey: 'settings.weekStartMon' as const, value: 1 }, { labelKey: 'settings.weekStartSun' as const, value: 0 }] as const).map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.weekStartBtn, weekStartDay === opt.value && styles.weekStartBtnActive]}
                  onPress={() => { Haptics.selectionAsync(); setWeekStartDay(opt.value); }}
                >
                  <Text style={[styles.weekStartBtnText, weekStartDay === opt.value && styles.weekStartBtnTextActive]}>
                    {t(opt.labelKey)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Stamps */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{t('settings.stamps')}</Text>
            <TouchableOpacity
              style={styles.sectionBtn}
              onPress={() => setAddStampVisible(true)}
            >
              <Ionicons name="add" size={16} color={colors.primary} />
              <Text style={styles.sectionBtnText}>{t('settings.create')}</Text>
            </TouchableOpacity>
          </View>

          {/* メインスタンプ */}
          <Text style={styles.subLabel}>{t('settings.mainStamps')}</Text>
          {mainStamps.map((stamp) => (
            <StampRow
              key={stamp.id}
              stamp={stamp}
              onEdit={() => openEdit(stamp)}
              onToggle={() => { Haptics.selectionAsync(); toggleEnabled(stamp.id); }}
              onDelete={stamp.isDefault ? undefined : () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                Alert.alert(t('stamp.deleteTitle'), t('stamp.deleteMsg', { name: stamp.text }), [
                  { text: t('common.cancel'), style: 'cancel' },
                  { text: t('common.delete'), style: 'destructive', onPress: () => removeStamp(stamp.id) },
                ]);
              }}
            />
          ))}

          {/* ミニスタンプ */}
          <Text style={[styles.subLabel, { marginTop: 16 }]}>{t('settings.miniStamps')}</Text>
          {miniStamps.map((stamp) => (
            <StampRow
              key={stamp.id}
              stamp={stamp}
              onEdit={() => openEdit(stamp)}
              onToggle={() => { Haptics.selectionAsync(); toggleEnabled(stamp.id); }}
              onDelete={stamp.isDefault ? undefined : () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                Alert.alert(t('stamp.deleteTitle'), t('stamp.deleteMsg', { name: stamp.text }), [
                  { text: t('common.cancel'), style: 'cancel' },
                  { text: t('common.delete'), style: 'destructive', onPress: () => removeStamp(stamp.id) },
                ]);
              }}
            />
          ))}

          <TouchableOpacity
            style={[styles.dangerBtn, { marginTop: 16 }]}
            onPress={() => {
              Alert.alert(t('stamp.resetTitle'), t('stamp.resetDesc'), [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('common.reset'), style: 'destructive', onPress: resetStamps },
              ]);
            }}
          >
            <Ionicons name="refresh-outline" size={14} color="#EF4444" />
            <Text style={styles.dangerBtnText}>{t('stamp.resetBtn')}</Text>
          </TouchableOpacity>

          {/* 画像スタンプ */}
          <Text style={[styles.subLabel, { marginTop: 16 }]}>{t('settings.imageStamps')}</Text>
          <View style={styles.imageStampGrid}>
            {imageStamps.map((stamp) => {
              const isIcon = stamp.imageUri?.startsWith('icon://');
              const iconName = isIcon ? stamp.imageUri!.replace('icon://', '') : '';
              return (
                <View key={stamp.id} style={styles.imageStampItem}>
                  <View style={[styles.imageStampImg, { backgroundColor: stamp.bgColor }]}>
                    {isIcon
                      ? <Ionicons name={iconName as any} size={28} color={stamp.textColor} />
                      : <Image source={{ uri: stamp.imageUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                    }
                  </View>
                  {!stamp.isDefault && (
                    <TouchableOpacity
                      style={styles.imageStampDelete}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        Alert.alert(t('stamp.deleteTitle'), t('stamp.imageDelete'), [
                          { text: t('common.cancel'), style: 'cancel' },
                          { text: t('common.delete'), style: 'destructive', onPress: () => removeStamp(stamp.id) },
                        ]);
                      }}
                    >
                      <Ionicons name="close-circle" size={20} color="#EF4444" />
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
            {/* 追加ボタン */}
            <TouchableOpacity style={styles.imageStampAdd} onPress={handleAddImageStamp}>
              <Ionicons name="image-outline" size={22} color={colors.primary} />
              <Text style={styles.imageStampAddText}>{t('settings.add')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Recurring */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{t('settings.recurring')}</Text>
            <TouchableOpacity
              style={styles.sectionBtn}
              onPress={() => setRecurringVisible(true)}
            >
              <Ionicons name="add" size={16} color={colors.primary} />
              <Text style={styles.sectionBtnText}>{t('settings.add')}</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.specialListBtn}
            onPress={() => setRecurringListVisible(true)}
          >
            <Ionicons name="repeat" size={18} color={colors.primary} />
            <Text style={styles.specialListBtnText}>{t('settings.recurringList')}</Text>
            {recurringSchedules.length > 0 && (
              <View style={styles.specialBadge}>
                <Text style={styles.specialBadgeText}>{recurringSchedules.length}</Text>
              </View>
            )}
            <Ionicons name="chevron-forward" size={16} color={colors.textLight} style={{ marginLeft: 'auto' }} />
          </TouchableOpacity>
        </View>

        {/* Birthday */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{t('settings.birthdaySection')}</Text>
            <TouchableOpacity
              style={styles.sectionBtn}
              onPress={() => setBirthdayVisible(true)}
            >
              <Ionicons name="add" size={16} color={colors.primary} />
              <Text style={styles.sectionBtnText}>{t('settings.add')}</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.specialListBtn}
            onPress={() => { setSpecialListTab('birthday'); setSpecialListVisible(true); }}
          >
            <Ionicons name="gift-outline" size={18} color={colors.primary} />
            <Text style={styles.specialListBtnText}>{t('settings.birthdayList')}</Text>
            {specialDates.length > 0 && (
              <View style={styles.specialBadge}>
                <Text style={styles.specialBadgeText}>{specialDates.length}</Text>
              </View>
            )}
            <Ionicons name="chevron-forward" size={16} color={colors.textLight} style={{ marginLeft: 'auto' }} />
          </TouchableOpacity>
        </View>

        {/* Google連携 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.google')}</Text>
          <View style={[styles.card, { marginTop: 12 }]}>
            {isSignedIn ? (
              <>
                <View style={styles.googleAccountRow}>
                  <View style={styles.googleIconBox}>
                    <Text style={styles.googleIconText}>G</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.googleName}>{userName}</Text>
                    <Text style={styles.googleEmail}>{userEmail}</Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.googleSignOutBtn, Platform.OS === 'web' && ({ cursor: 'pointer' } as const)]}
                    onPress={() => confirmGoogleDisconnect(handleSignOut)}
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.googleDisconnectA11y')}
                  >
                    <Text style={styles.googleSignOutText}>{t('settings.googleDisconnect')}</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.googleDivider} />

                <Text style={[styles.subLabel, { marginTop: 0 }]}>{t('settings.syncDirection')}</Text>
                <View style={styles.googleModeRow}>
                  {([
                    { key: 'fromGoogle' as const, labelKey: 'settings.syncFrom' as const },
                    { key: 'toGoogle' as const, labelKey: 'settings.syncTo' as const },
                    { key: 'both' as const, labelKey: 'settings.syncBoth' as const },
                  ]).map((opt) => (
                    <TouchableOpacity
                      key={opt.key}
                      style={[styles.googleModeBtn, googleSyncMode === opt.key && styles.googleModeBtnActive]}
                      onPress={() => { Haptics.selectionAsync(); setGoogleSyncMode(opt.key); }}
                      activeOpacity={0.85}
                    >
                      <Text style={[styles.googleModeBtnText, googleSyncMode === opt.key && styles.googleModeBtnTextActive]}>
                        {t(opt.labelKey)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity
                  style={[styles.googleSyncBtn, syncing && { opacity: 0.6 }]}
                  onPress={handleGoogleSync}
                  disabled={syncing}
                >
                  {syncing ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Ionicons name="sync-outline" size={16} color="#FFFFFF" />
                  )}
                  <Text style={styles.googleSyncBtnText}>
                    {syncing ? t('settings.syncing') : t('settings.syncBtn')}
                  </Text>
                </TouchableOpacity>

                <Text style={styles.googleSyncNote}>
                  {t('settings.googleNote')}
                </Text>
                <Text style={[styles.googleSyncNote, { marginTop: 6 }]}>
                  {t('settings.lastSync')}: {lastSyncedAt ? new Date(lastSyncedAt).toLocaleString(dateLocaleTag(locale)) : t('settings.neverSynced')}
                </Text>
                {googleSyncErrorText ? (
                  <Text style={[styles.googleSyncNote, { marginTop: 8, color: '#EF4444' }]}>
                    {t('settings.errorDetail')}: {googleSyncErrorText}
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                {/* WebはAlertが出ない環境があるため、画面上に常時表示 */}
                {Platform.OS === 'web' ? (
                  <View style={styles.googleWebHelp}>
                    <Text style={styles.googleWebHelpTitle}>{t('settings.googleWebTitle')}</Text>
                    <Text style={styles.googleWebHelpText}>
                      {t('settings.googleWeb1')}
                    </Text>
                    <View style={styles.googleUriBox}>
                      <Text style={styles.googleUriText} selectable>
                        {redirectUri}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.googleCopyBtn}
                      onPress={async () => {
                        await Clipboard.setStringAsync(redirectUri);
                        try { (globalThis as any)?.alert?.(t('settings.googleWebCopyDone')); } catch {}
                      }}
                    >
                      <Ionicons name="copy-outline" size={14} color={colors.primary} />
                      <Text style={styles.googleCopyBtnText}>{t('settings.googleCopy')}</Text>
                    </TouchableOpacity>
                    <Text style={styles.googleWebHelpText}>
                      {t('settings.googleWeb2')}
                    </Text>
                  </View>
                ) : null}

                <Text style={styles.googleDesc}>
                  {t('settings.googleDesc')}
                </Text>
                <TouchableOpacity
                  style={[
                    styles.googleLoginBtn,
                    Platform.OS === 'web' && !!clientId && !googleAuthRequest && { opacity: 0.55 },
                  ]}
                  disabled={Platform.OS === 'web' && !!clientId && !googleAuthRequest}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    // Webは「何も起きない」に見えやすいので、まずredirectUriを必ず表示できるようにする
                    if (Platform.OS === 'web') {
                      // Webは上の案内カードを見せる。ここはログイン実行だけにする。
                      if (!clientId) {
                        try { (globalThis as any)?.alert?.(t('settings.googleEnvMissing')); } catch {}
                        return;
                      }
                      if (!googleAuthRequest) {
                        try {
                          (globalThis as any)?.alert?.(t('settings.googlePreparingAlert'));
                        } catch {}
                        return;
                      }
                      handleSignIn();
                      return;
                    }

                    // iOS/Android: 設定が空だと「何も起きない」ように見えるので、必要情報を出す
                    if (!clientId) {
                      Alert.alert(
                        t('settings.googleIosMissingTitle'),
                        t('settings.googleIosMissingBody', { redirectUri })
                      );
                      return;
                    }

                    handleSignIn();
                  }}
                >
                  <View style={styles.googleIconSmall}>
                    <Text style={styles.googleIconSmallText}>G</Text>
                  </View>
                  <Text style={styles.googleLoginBtnText}>
                    {Platform.OS === 'web' && !!clientId && !googleAuthRequest ? t('settings.googlePreparing') : t('settings.googleLogin')}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>

        {/* About */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.about')}</Text>
          <View style={styles.card}>
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>{t('settings.version')}</Text>
              <Text style={styles.aboutValue}>1.0.0</Text>
            </View>
            <View style={[styles.aboutRow, { borderBottomWidth: 0 }]}>
              <Text style={styles.aboutLabel}>{t('settings.stampCount')}</Text>
              <Text style={styles.aboutValue}>
                {t('settings.stampCountUnit') ? `${stamps.length}${t('settings.stampCountUnit')}` : String(stamps.length)}
              </Text>
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
      <RecurringListModal
        visible={recurringListVisible}
        onClose={() => setRecurringListVisible(false)}
        onAdd={() => { setRecurringListVisible(false); setTimeout(() => setRecurringVisible(true), 300); }}
      />
      <BirthdayModal visible={birthdayVisible} onClose={() => setBirthdayVisible(false)} />
      <SpecialDatesListModal
        visible={specialListVisible}
        initialTab={specialListTab}
        onClose={() => setSpecialListVisible(false)}
        onAdd={() => { setSpecialListVisible(false); setTimeout(() => setBirthdayVisible(true), 300); }}
      />
    </SafeAreaView>
  );
}

// ── 繰り返し予定一覧モーダル ──
const WD_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function RecurringListModal({ visible, onClose, onAdd }: { visible: boolean; onClose: () => void; onAdd: () => void }) {
  const recurringSchedules = useCalendarStore((s) => s.recurringSchedules);
  const removeRecurring = useCalendarStore((s) => s.removeRecurring);
  const { t, locale } = useTranslation();

  const formatMonthLabel = (m: string) => {
    const [y, mo] = m.split('-');
    const moNum = parseInt(mo, 10);
    if (locale === 'ja') return `${y}年${moNum}月`;
    const d = new Date(parseInt(y, 10), moNum - 1, 1);
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  };

  return (
    <RNModal transparent animationType="slide" visible={visible} onRequestClose={onClose} statusBarTranslucent>
      <View style={slStyles.overlay}>
        <View style={slStyles.sheet}>
          <View style={slStyles.handle} />
          <View style={slStyles.header}>
            <Text style={slStyles.title}>{t('recurring.title')}</Text>
            <TouchableOpacity onPress={onClose} style={slStyles.closeBtn}>
              <Text style={slStyles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={slStyles.list} showsVerticalScrollIndicator={false}>
            {recurringSchedules.length === 0 ? (
              <View style={slStyles.empty}>
                <Text style={slStyles.emptyText}>{t('recurring.empty')}</Text>
              </View>
            ) : (
              recurringSchedules.map((rs) => (
                <View key={rs.id} style={slStyles.item}>
                  <View style={rlStyles.info}>
                    <Text style={rlStyles.name}>{rs.name}</Text>
                    <Text style={rlStyles.sub}>
                      {(() => {
                        const dayPart = rs.daysOfWeek.map((d) => t(`weekday.${WD_KEYS[d]}`)).join(locale === 'ja' ? '・' : ' · ');
                        const dayStr = locale === 'ja' ? `${dayPart}${t('recurring.weekdaySuffix')}` : dayPart;
                        const pos =
                          rs.stampPosition === 'main'
                            ? t('recurring.mainBand')
                            : rs.stampPosition === 'mini-left'
                              ? t('recurring.miniLeft')
                              : t('recurring.miniRight');
                        return locale === 'ja' ? `${dayStr}${pos}` : `${dayStr} — ${pos}`;
                      })()}
                    </Text>
                    {rs.appliedMonths && rs.appliedMonths.length > 0 && (
                      <Text style={rlStyles.months}>
                        {t('recurring.appliedLabel')}
                        {rs.appliedMonths.map((m) => formatMonthLabel(m)).join(locale === 'ja' ? '・' : ' · ')}
                      </Text>
                    )}
                    {(!rs.appliedMonths || rs.appliedMonths.length === 0) && (
                      <Text style={rlStyles.noMonths}>{t('recurring.notApplied')}</Text>
                    )}
                  </View>
                  <TouchableOpacity
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      removeRecurring(rs.id);
                    }}
                  >
                    <Ionicons name="trash-outline" size={18} color="#EF4444" />
                  </TouchableOpacity>
                </View>
              ))
            )}
            <View style={{ height: 20 }} />
          </ScrollView>

          <TouchableOpacity style={slStyles.addBtn} onPress={onAdd}>
            <Ionicons name="add" size={18} color="#FFFFFF" />
            <Text style={slStyles.addBtnText}>{t('recurring.addNew')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </RNModal>
  );
}

const rlStyles = StyleSheet.create({
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: '700', color: colors.text },
  sub: { fontSize: 12, color: colors.textSecondary, marginTop: 3 },
  months: { fontSize: 11, color: colors.primary, marginTop: 4, fontWeight: '600' },
  noMonths: { fontSize: 11, color: colors.textLight, marginTop: 4 },
});

// ── 誕生日・記念日一覧モーダル ──
type SpecialTab = 'birthday' | 'anniversary' | 'other';

function SpecialDatesListModal({
  visible, initialTab, onClose, onAdd,
}: {
  visible: boolean;
  initialTab: SpecialTab;
  onClose: () => void;
  onAdd: () => void;
}) {
  const specialDates = useCalendarStore((s) => s.specialDates);
  const removeSpecialDate = useCalendarStore((s) => s.removeSpecialDate);
  const [tab, setTab] = useState<SpecialTab>(initialTab);
  const { t, locale } = useTranslation();

  const SPECIAL_TABS: { key: SpecialTab; labelKey: string }[] = [
    { key: 'birthday', labelKey: 'special.tab.birthday' },
    { key: 'anniversary', labelKey: 'special.tab.anniversary' },
    { key: 'other', labelKey: 'special.tab.other' },
  ];

  React.useEffect(() => { if (visible) setTab(initialTab); }, [visible, initialTab]);

  const filtered = specialDates
    .filter((sd) => sd.type === tab)
    .sort((a, b) => a.month !== b.month ? a.month - b.month : a.day - b.day);

  return (
    <RNModal transparent animationType="slide" visible={visible} onRequestClose={onClose} statusBarTranslucent>
      <View style={slStyles.overlay}>
        <View style={slStyles.sheet}>
          <View style={slStyles.handle} />
          <View style={slStyles.header}>
            <Text style={slStyles.title}>{t('special.title')}</Text>
            <TouchableOpacity onPress={onClose} style={slStyles.closeBtn}>
              <Text style={slStyles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* タブ */}
          <View style={slStyles.tabs}>
            {SPECIAL_TABS.map((tabDef) => {
              const count = specialDates.filter((sd) => sd.type === tabDef.key).length;
              return (
                <TouchableOpacity
                  key={tabDef.key}
                  style={[slStyles.tab, tab === tabDef.key && slStyles.tabActive]}
                  onPress={() => { Haptics.selectionAsync(); setTab(tabDef.key); }}
                >
                  <Text style={[slStyles.tabText, tab === tabDef.key && slStyles.tabTextActive]}>{t(tabDef.labelKey)}</Text>
                  {count > 0 && (
                    <View style={slStyles.tabBadge}>
                      <Text style={slStyles.tabBadgeText}>{count}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          {/* リスト */}
          <ScrollView style={slStyles.list} showsVerticalScrollIndicator={false}>
            {filtered.length === 0 ? (
              <View style={slStyles.empty}>
                <Text style={slStyles.emptyText}>{t('special.empty')}</Text>
              </View>
            ) : (
              filtered.map((sd) => (
                <View key={sd.id} style={slStyles.item}>
                  <Text style={slStyles.date}>
                    {locale === 'ja'
                      ? `${sd.month}月${sd.day}日`
                      : new Date(2024, sd.month - 1, sd.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </Text>
                  <Text style={slStyles.name}>{sd.name}</Text>
                  <TouchableOpacity
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      removeSpecialDate(sd.id);
                    }}
                  >
                    <Ionicons name="trash-outline" size={18} color="#EF4444" />
                  </TouchableOpacity>
                </View>
              ))
            )}
            <View style={{ height: 20 }} />
          </ScrollView>

          {/* 追加ボタン */}
          <TouchableOpacity style={slStyles.addBtn} onPress={onAdd}>
            <Ionicons name="add" size={18} color="#FFFFFF" />
            <Text style={slStyles.addBtnText}>{t('special.addNew')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </RNModal>
  );
}

const slStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingBottom: 32, maxHeight: '85%' },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#BFDBFE', alignSelf: 'center', marginTop: 10, marginBottom: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  title: { fontSize: 18, fontWeight: '800', color: colors.text },
  closeBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#F0E6F0', alignItems: 'center', justifyContent: 'center' },
  closeBtnText: { fontSize: 12, color: colors.textSecondary, fontWeight: '700' },
  tabs: { flexDirection: 'row', backgroundColor: '#F5EFF5', borderRadius: 12, padding: 3, marginBottom: 12 },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 4 },
  tabActive: { backgroundColor: '#FFFFFF', shadowColor: '#3B82F6', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 4, elevation: 2 },
  tabText: { fontSize: 13, fontWeight: '600', color: colors.textLight },
  tabTextActive: { color: colors.primary, fontWeight: '700' },
  tabBadge: { backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1 },
  tabBadgeText: { fontSize: 10, color: '#FFFFFF', fontWeight: '700' },
  list: { flex: 1 },
  empty: { alignItems: 'center', paddingVertical: 40 },
  emptyText: { fontSize: 14, color: colors.textLight },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#F5EFF5', gap: 12 },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  info: { flex: 1 },
  date: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, width: 60 },
  name: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.text },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.primary, borderRadius: 16, paddingVertical: 14, marginTop: 12, shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  addBtnText: { fontSize: 15, fontWeight: '800', color: '#FFFFFF' },
});

// ── スタンプ行コンポーネント ──
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
  const { t } = useTranslation();
  const isEnabled = stamp.isEnabled !== false;
  return (
    <View style={[rowStyles.row, !isEnabled && rowStyles.rowDisabled]}>
      <View style={[rowStyles.badge, { backgroundColor: stamp.bgColor, opacity: isEnabled ? 1 : 0.4 }]}>
        <Text style={[rowStyles.badgeText, { color: stamp.textColor }]}>{stamp.text}</Text>
      </View>
      <View style={rowStyles.info}>
        <Text style={rowStyles.label}>{stamp.text}</Text>
        <Text style={rowStyles.sub}>{stamp.isDefault ? t('settings.default') : t('settings.custom')}</Text>
      </View>
      <Switch
        value={isEnabled}
        onValueChange={onToggle}
        trackColor={{ false: '#BFDBFE', true: colors.primaryLight }}
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
    shadowColor: '#3B82F6', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 4, elevation: 1,
  },
  badge: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 14, fontWeight: '900' },
  info: { flex: 1 },
  label: { fontSize: 14, fontWeight: '700', color: colors.text },
  sub: { fontSize: 11, color: colors.textSecondary, marginTop: 1 },
  editBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: '#DBEAFE', alignItems: 'center', justifyContent: 'center' },
  deleteBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: '#FFF0F0', alignItems: 'center', justifyContent: 'center' },
  deletePlaceholder: { width: 34 },
  rowDisabled: { opacity: 0.75 },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  specialItem: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 12, marginBottom: 8, shadowColor: '#3B82F6', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  specialIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  specialInfo: { flex: 1 },
  specialName: { fontSize: 14, fontWeight: '700', color: colors.text },
  specialDate: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  specialListBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, shadowColor: '#3B82F6', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4, elevation: 1 },
  specialListBtnText: { fontSize: 15, fontWeight: '700', color: colors.text, flex: 1 },
  specialBadge: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  specialBadgeText: { fontSize: 11, color: '#FFFFFF', fontWeight: '700' },
  header: { paddingHorizontal: 20, paddingVertical: 14 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: colors.text, flex: 1 },
  langRow: { flexDirection: 'row', gap: 6 },
  langChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  langChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  langChipText: { fontSize: 12, fontWeight: '800', color: colors.text },
  langChipTextActive: { color: '#FFFFFF' },
  scroll: { flex: 1 },
  section: { paddingHorizontal: 16, marginTop: 20 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  sectionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#DBEAFE', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  sectionBtnText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  card: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16, shadowColor: '#3B82F6', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 2 },
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
  recurringItem: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, flexDirection: 'row', alignItems: 'center', marginBottom: 8, shadowColor: '#3B82F6', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  recurringInfo: { flex: 1 },
  recurringName: { fontSize: 14, fontWeight: '700', color: colors.text },
  recurringDays: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  deleteBtn: { padding: 6, backgroundColor: '#FFF0F0', borderRadius: 8 },
  aboutRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.divider },
  aboutLabel: { fontSize: 14, color: colors.textSecondary, fontWeight: '500' },
  aboutValue: { fontSize: 14, color: colors.text, fontWeight: '700' },
  weekStartRow: { flexDirection: 'row', gap: 10 },
  weekStartBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 10,
    backgroundColor: '#F5EFF5', alignItems: 'center',
    borderWidth: 2, borderColor: 'transparent',
  },
  weekStartBtnActive: {
    backgroundColor: '#DBEAFE', borderColor: colors.primary,
  },
  weekStartBtnText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  weekStartBtnTextActive: { color: colors.primary, fontWeight: '800' },
  imageStampGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  imageStampItem: { position: 'relative' },
  imageStampImg: { width: 56, height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  imageStampDelete: { position: 'absolute', top: -6, right: -6 },
  imageStampAdd: { width: 56, height: 56, borderRadius: 14, borderWidth: 2, borderColor: colors.primaryLight, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 2 },
  imageStampAddText: { fontSize: 10, color: colors.primary, fontWeight: '700' },

  // Google連携
  googleAccountRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  googleIconBox: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#4285F4', alignItems: 'center', justifyContent: 'center' },
  googleIconText: { fontSize: 22, fontWeight: '900', color: '#FFFFFF' },
  googleName: { fontSize: 15, fontWeight: '700', color: colors.text },
  googleEmail: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  googleSignOutBtn: { backgroundColor: '#FFF0F0', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  googleSignOutText: { fontSize: 13, fontWeight: '700', color: '#EF4444' },
  googleDivider: { height: 1, backgroundColor: colors.divider, marginVertical: 14 },
  googleSyncBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#4285F4', borderRadius: 12, paddingVertical: 12, shadowColor: '#4285F4', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 3 },
  googleSyncBtnText: { fontSize: 15, fontWeight: '800', color: '#FFFFFF' },
  googleSyncNote: { fontSize: 11, color: colors.textLight, marginTop: 10, lineHeight: 16, textAlign: 'center' },
  googleDesc: { fontSize: 13, color: colors.textSecondary, lineHeight: 20, marginBottom: 16 },
  googleLoginBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#FFFFFF', borderRadius: 12, paddingVertical: 12, borderWidth: 1.5, borderColor: '#DADCE0' },
  googleLoginBtnText: { fontSize: 15, fontWeight: '700', color: colors.text },
  googleIconSmall: { width: 24, height: 24, borderRadius: 4, backgroundColor: '#4285F4', alignItems: 'center', justifyContent: 'center' },
  googleIconSmallText: { fontSize: 14, fontWeight: '900', color: '#FFFFFF' },
  googleWebHelp: { backgroundColor: '#F8FAFF', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.primaryLight, marginBottom: 12 },
  googleWebHelpTitle: { fontSize: 13, fontWeight: '800', color: colors.text, marginBottom: 6 },
  googleWebHelpText: { fontSize: 12, color: colors.textSecondary, lineHeight: 18, marginBottom: 8 },
  googleUriBox: { backgroundColor: '#FFFFFF', borderRadius: 10, padding: 10, borderWidth: 1, borderColor: colors.divider, marginBottom: 10 },
  googleUriText: { fontSize: 12, color: colors.text, lineHeight: 18 },
  googleCopyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#DBEAFE', borderRadius: 10, paddingVertical: 10, marginBottom: 10 },
  googleCopyBtnText: { fontSize: 12, fontWeight: '800', color: colors.primary },
  googleModeRow: { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 14, flexWrap: 'wrap' },
  googleModeBtn: { flexGrow: 1, backgroundColor: '#F5EFF5', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center' },
  googleModeBtnActive: { backgroundColor: '#E8F0FE', borderWidth: 1.5, borderColor: '#4285F4' },
  googleModeBtnText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  googleModeBtnTextActive: { color: '#4285F4' },
});
