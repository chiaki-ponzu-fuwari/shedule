import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, Modal, TouchableWithoutFeedback, TouchableOpacity, Pressable,
  StyleSheet, ScrollView, TextInput, ActivityIndicator, Platform, Dimensions, Image, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Haptics } from '../../utils/haptics';
import { useGroupStore } from '../../store/groupStore';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { colors } from '../../constants/colors';
import { Group, GroupSharingSettings, SharedEntry } from '../../types';
import { formatShortDateParts, formatCalendarMonthTitle, getWeekdayLabels } from '../../utils/dateUtils';
import { useTranslation } from '../../constants/i18n';
import * as ImagePicker from 'expo-image-picker';
import { compressPickedImageUri } from '../../utils/compressPickedImage';
import { TimelineHourLabel } from '../ui/TimelineHourLabel';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const MINI_CAL_GAP = 8;
const MINI_CAL_W = Math.floor((SCREEN_W - 40 - MINI_CAL_GAP) / 2);
const MINI_CELL_W = Math.floor((MINI_CAL_W - 16) / 7);
const MINI_CELL_H = MINI_CELL_W + 7;
const BIG_CELL_W = Math.floor((SCREEN_W - 40) / 7);
const BIG_CELL_H = 62;
const SC_MARGIN = 2;  // shared calendar cell margin
const SC_W = Math.floor((SCREEN_W - 40 - SC_MARGIN * 2 * 7) / 7);
const SC_H = 74;
const TODAY_STR = new Date().toISOString().slice(0, 10);
const FOOTER_H = 56; // 約1.5cm相当（目安）

function isInvalidEmoji(s?: string) {
  const v = (s ?? '').trim();
  return !v || v === '?' || v === '？';
}

function normalizeTimeToken(raw: string) {
  return raw
    .replace(/：/g, ':')
    .replace(/[~～]/g, '〜')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNotesForShare(rawNotes: string) {
  const src = (rawNotes ?? '').trim();
  if (!src) return '';
  // 旧フォーマット混在を吸収（改行/スラッシュ区切り）
  const parts = src.includes(' / ')
    ? src.split(' / ')
    : src.split(/\n+/);
  const normalized = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^\s*(\d{1,2}[:：]\d{2}(?:\s*[〜~～]\s*\d{1,2}[:：]\d{2})?)\s*(.+)\s*$/);
      if (!m) return p;
      const time = normalizeTimeToken(m[1]).replace(/\s*/g, '');
      const text = m[2].trim();
      return `${time} ${text}`;
    });
  return normalized.join(' / ');
}

function buildCalendarWeeks(year: number, month: number): (number | null)[][] {
  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const weeks: (number | null)[][] = [];
  let week: (number | null)[] = Array(firstDay).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    week.push(d);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return weeks;
}

const hapticSelect = () => { if (Platform.OS !== 'web') Haptics.selectionAsync(); };
const hapticNotify = () => { if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); };

type Tab = 'info' | 'settings' | 'schedule';

const DEFAULT_SHARING: GroupSharingSettings = { shareMain: true, shareMini: false, shareNotes: false, shareTimeSchedule: false };
const EMPTY_ENTRIES: SharedEntry[] = [];

const DATE_COL_W = 68;
const MEMBER_COL_W = 82;

function parseNoteItems(notes: string): { time?: string; content: string }[] {
  const src = (notes ?? '').trim();
  const rawItems = src.includes(' / ')
    ? src.split(' / ')
    : src.split(/\n+/);
  return rawItems.filter(s => s.trim()).map(item => {
    // 共有データ側の揺れ（時刻の後に空白が無い等）を吸収する
    const m = item.trim().match(/^(\d{1,2}[:：]\d{2}(?:\s*[〜~～]\s*\d{1,2}[:：]\d{2})?)\s*(.+)$/);
    if (m) return { time: normalizeTimeToken(m[1]).replace(/\s*/g, ''), content: m[2].trim() };
    return { content: item.trim() };
  });
}

interface Props {
  group: Group;
  visible: boolean;
  onClose: () => void;
  onDelete: (group: Group) => void;
  onShare: (group: Group) => void;
}

export function GroupDetailSheet({ group, visible, onClose, onDelete, onShare }: Props) {
  const { t, locale } = useTranslation();
  const formatShortDate = useCallback(
    (dateStr: string) => formatShortDateParts(dateStr, locale),
    [locale]
  );
  const sunFirstLabels = useMemo(() => getWeekdayLabels(0, locale).map((x) => x.label), [locale]);

  const [tab, setTab] = useState<Tab>('info');
  const [memoEdit, setMemoEdit] = useState(group.sharedMemo ?? '');
  const [syncing, setSyncing] = useState(false);
  const [scheduleError, setScheduleError] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [scheduleView, setScheduleView] = useState<'table' | 'calendar'>('table');
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth() + 1);
  const [expandedCalMemberId, setExpandedCalMemberId] = useState<string | null>(null);
  const [expandedSelDate, setExpandedSelDate] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'memo' | 'timeschedule'>('memo');
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);

  const updateSharedMemo = useGroupStore((s) => s.updateSharedMemo);
  const updateGroupName = useGroupStore((s) => s.updateGroupName);
  const setGroupIconUri = useGroupStore((s) => s.setGroupIconUri);
  const sharingSettings = useGroupStore((s) => s.sharingSettings[group.id] ?? DEFAULT_SHARING);
  const setSharingSettings = useGroupStore((s) => s.setSharingSettings);
  const syncMySchedule = useGroupStore((s) => s.syncMySchedule);
  const fetchGroupSchedules = useGroupStore((s) => s.fetchGroupSchedules);
  const sharedEntries = useGroupStore((s) => s.sharedEntries[group.id] ?? EMPTY_ENTRIES);
  const myUserId = useGroupStore((s) => s.myUserId);
  const myName = useGroupStore((s) => s.myName);

  const entries = useCalendarStore((s) => s.entries);
  const getStamp = useStampStore((s) => s.getStamp);

  useEffect(() => {
    if (!visible) return;
    setMemoEdit(group.sharedMemo ?? '');
    setNameDraft(group.name);
    setNameEditing(false);
  }, [visible]);

  useEffect(() => {
    // groupが更新されたとき追従（名前・アイコン）
    setNameDraft(group.name);
  }, [group.name]);

  useEffect(() => {
    if (!visible) return;
    setScheduleError('');
    fetchGroupSchedules(group.id).catch((e: any) => {
      setScheduleError(e?.message ?? t('groupDetail.fetchErr'));
    });
  }, [visible, group.id, fetchGroupSchedules]);

  const toggleSetting = (key: keyof GroupSharingSettings) => {
    hapticSelect();
    setSharingSettings(group.id, { ...sharingSettings, [key]: !sharingSettings[key] });
  };

  const handleSync = async () => {
    setSyncing(true);
    setScheduleError('');
    hapticSelect();

    const buildTimeSlotsForSync = (date: string, entry: (typeof entries)[string]) => {
      if (!sharingSettings.shareTimeSchedule) return undefined;
      const fromTimeline = [...(entry.timeSlots ?? [])];
      const hasDayRange = Boolean(entry.startTime?.trim() || entry.endTime?.trim());
      if (fromTimeline.length > 0) return fromTimeline;
      if (hasDayRange) {
        const st = (entry.startTime ?? '00:00').trim() || '00:00';
        const et = (entry.endTime ?? st).trim() || st;
        return [
          {
            id: `day_${date}`,
            startTime: st,
            endTime: et,
            title: '',
            color: group.color ?? '#94A3B8',
          },
        ];
      }
      return [];
    };

    try {
      const syncData = Object.entries(entries)
        .filter(([, entry]) => {
          if (sharingSettings.shareMain && entry.mainStampId) return true;
          if (sharingSettings.shareMini && (entry.miniStamps?.left || entry.miniStamps?.right)) return true;
          if (sharingSettings.shareNotes && (entry.notes || (entry.noteItems && entry.noteItems.length > 0))) return true;
          if (sharingSettings.shareTimeSchedule) {
            if (entry.timeSlots && entry.timeSlots.length > 0) return true;
            if (entry.startTime?.trim() || entry.endTime?.trim()) return true;
          }
          return false;
        })
        .map(([date, entry]) => {
          const mainStamp = sharingSettings.shareMain && entry.mainStampId ? getStamp(entry.mainStampId) : undefined;
          const leftMini = sharingSettings.shareMini && entry.miniStamps?.left ? getStamp(entry.miniStamps.left) : undefined;
          const rightMini = sharingSettings.shareMini && entry.miniStamps?.right ? getStamp(entry.miniStamps.right) : undefined;

          let notesText: string | undefined;
          if (sharingSettings.shareNotes) {
            const items = entry.noteItems ?? [];
            const parts = items.map((i) => {
              if (i.time) {
                const timeStr = i.endTime ? `${i.time}〜${i.endTime}` : i.time;
                return `${normalizeTimeToken(timeStr).replace(/\s*/g, '')} ${(i.text ?? '').trim()}`.trim();
              }
              return (i.text ?? '').trim();
            }).filter(Boolean);
            if (parts.length > 0) notesText = parts.join(' / ');
            else if (entry.notes) notesText = normalizeNotesForShare(entry.notes);
          }

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
            timeSlots: buildTimeSlotsForSync(date, entry),
          };
        });

      await syncMySchedule(group.id, syncData);
      await fetchGroupSchedules(group.id);
      hapticNotify();
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setScheduleError(msg);
      Alert.alert(t('groups.errTitle'), msg);
    } finally {
      setSyncing(false);
    }
  };

  // 列は group.members 全員（shared_entries にまだ行がない人が列から消えるのを防ぐ）
  const myMemberColor = group.members.find(m => m.id === myUserId)?.color ?? '#A78BFA';
  const tableMembers = useMemo(() => {
    const list = [...group.members].sort((a, b) => {
      if (a.id === myUserId) return -1;
      if (b.id === myUserId) return 1;
      return 0;
    });
    return list.map((m) => ({ id: m.id, name: m.name, color: m.color }));
  }, [group.members, myUserId]);

  /** 表示は常にグループメンバー名に合わせる（DB の user_name とズレを解消） */
  const sharedEntriesForDisplay = useMemo(() => {
    const nameById = new Map(group.members.map((m) => [m.id, m.name]));
    return sharedEntries.map((e) => ({
      ...e,
      userName: nameById.get(e.userId) ?? e.userName,
    }));
  }, [sharedEntries, group.members]);

  const allDates = [...new Set(sharedEntriesForDisplay.map((e) => e.date))].sort();
  // [date][userId] = SharedEntry
  const entryMap: Record<string, Record<string, SharedEntry>> = {};
  sharedEntriesForDisplay.forEach((e) => {
    if (!entryMap[e.date]) entryMap[e.date] = {};
    entryMap[e.date][e.userId] = e;
  });

  // 選択メンバーの詳細データ
  const selectedMemberEntries = selectedMemberId
    ? sharedEntriesForDisplay
        .filter((e) => e.userId === selectedMemberId)
        .sort((a, b) => a.date.localeCompare(b.date))
    : [];

  const calWeeks = buildCalendarWeeks(calYear, calMonth);
  const prevCalMonth = () => {
    if (calMonth === 1) { setCalYear(calYear - 1); setCalMonth(12); }
    else setCalMonth(calMonth - 1);
  };
  const nextCalMonth = () => {
    if (calMonth === 12) { setCalYear(calYear + 1); setCalMonth(1); }
    else setCalMonth(calMonth + 1);
  };

  return (
    <>
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.overlay}>
        {/* 全画面 Pressable は Web でシートと重なりタッチを奪うため、シート上に被らない上側のみタップで閉じる */}
        <Pressable style={styles.backdropTap} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
              <View style={styles.handle} />

              {/* ヘッダー */}
              <View style={styles.detailHeader}>
                <View style={[styles.groupHeaderIcon, { backgroundColor: group.color + '22' }]}>
                  {group.iconUri ? (
                    <Image source={{ uri: group.iconUri }} style={styles.groupHeaderIconImage} />
                  ) : (
                    <Text style={styles.groupHeaderEmoji}>{isInvalidEmoji(group.emoji) ? '👥' : group.emoji}</Text>
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  {nameEditing ? (
                    <TextInput
                      style={styles.groupNameInput}
                      value={nameDraft}
                      onChangeText={setNameDraft}
                      autoFocus
                      returnKeyType="done"
                      onSubmitEditing={async () => {
                        await updateGroupName(group.id, nameDraft);
                        setNameEditing(false);
                      }}
                      onBlur={async () => {
                        await updateGroupName(group.id, nameDraft);
                        setNameEditing(false);
                      }}
                    />
                  ) : (
                    <View style={styles.groupNameRow}>
                      <Text style={styles.modalTitle}>{group.name}</Text>
                      <TouchableOpacity onPress={() => { hapticSelect(); setNameEditing(true); }} style={styles.editBtn}>
                        <Ionicons name="pencil-outline" size={14} color={colors.textSecondary} />
                      </TouchableOpacity>
                    </View>
                  )}
                  <Text style={styles.subText}>{t('groupDetail.memberLine', { n: group.members.length })}</Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    hapticSelect();
                    onDelete(group);
                  }}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityRole="button"
                  accessibilityLabel={t('groups.leaveBtn')}
                >
                  <Ionicons name="exit-outline" size={22} color="#EF4444" />
                </TouchableOpacity>
              </View>

              {/* タブ */}
              <View style={styles.tabRow}>
                {([
                  { key: 'info' as const, labelKey: 'groupDetail.tabInfo' as const },
                  { key: 'settings' as const, labelKey: 'groupDetail.tabSettings' as const },
                  { key: 'schedule' as const, labelKey: 'groupDetail.tabSchedule' as const },
                ]).map(({ key, labelKey }) => (
                  <TouchableOpacity
                    key={key}
                    style={[styles.tab, tab === key && styles.tabActive]}
                    onPress={() => { hapticSelect(); setTab(key); }}
                  >
                    <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>
                      {t(labelKey)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always">
                {tab === 'info' ? (
                  <View>
                    {/* グループアイコン */}
                    <Text style={styles.fieldLabel}>{t('groupDetail.gIcon')}</Text>
                    <View style={styles.iconEditRow}>
                      <View style={[styles.iconPreview, { backgroundColor: group.color + '22' }]}>
                        {group.iconUri ? (
                          <Image source={{ uri: group.iconUri }} style={styles.iconPreviewImage} />
                        ) : (
                          <Text style={styles.iconPreviewEmoji}>{isInvalidEmoji(group.emoji) ? '👥' : group.emoji}</Text>
                        )}
                      </View>
                      <View style={{ flex: 1 }}>
                        <TouchableOpacity
                          style={styles.iconEditBtn}
                          onPress={async () => {
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
                              setGroupIconUri(group.id, uri);
                              hapticNotify();
                            }
                          }}
                        >
                          <Ionicons name="image-outline" size={16} color={colors.primary} />
                          <Text style={styles.iconEditBtnText}>{t('groupDetail.changeImage')}</Text>
                        </TouchableOpacity>
                        {group.iconUri ? (
                          <TouchableOpacity
                            style={[styles.iconEditBtn, styles.iconEditBtnSecondary]}
                            onPress={() => { setGroupIconUri(group.id, undefined); hapticSelect(); }}
                          >
                            <Ionicons name="close" size={16} color={colors.textSecondary} />
                            <Text style={[styles.iconEditBtnText, { color: colors.textSecondary }]}>{t('groupDetail.removeImage')}</Text>
                          </TouchableOpacity>
                        ) : null}
                        <Text style={styles.iconHint}>{t('groupDetail.iconHint')}</Text>
                      </View>
                    </View>

                    {/* 招待コード */}
                    <View style={styles.inviteCodeRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.inviteCodeLabel}>{t('groupDetail.inviteCode')}</Text>
                        <Text style={styles.inviteCode}>{group.inviteCode}</Text>
                      </View>
                      <TouchableOpacity style={styles.shareBtn} onPress={() => onShare(group)}>
                        <Ionicons name="share-outline" size={18} color="#FFFFFF" />
                        <Text style={styles.shareBtnText}>{t('groupDetail.shareInvite')}</Text>
                      </TouchableOpacity>
                    </View>

                    {/* メンバー */}
                    <Text style={styles.fieldLabel}>{t('groupDetail.members')}</Text>
                    {group.members.map((m) => (
                      <View key={m.id} style={styles.memberRow}>
                        <View style={[styles.avatar, { backgroundColor: m.color }]}>
                          <Text style={styles.avatarText}>{m.name?.charAt(0) ?? '?'}</Text>
                        </View>
                        <Text style={styles.memberName}>{m.name}</Text>
                        {m.isOwner && <View style={styles.ownerBadge}><Text style={styles.ownerText}>{t('groupDetail.owner')}</Text></View>}
                      </View>
                    ))}

                    {/* 共有メモ */}
                    <Text style={styles.fieldLabel}>{t('groupDetail.memo')}</Text>
                    <TextInput
                      style={styles.memoInput}
                      value={memoEdit}
                      onChangeText={(text) => { setMemoEdit(text); updateSharedMemo(group.id, text); }}
                      placeholder={t('groupDetail.memoPh')}
                      placeholderTextColor={colors.textLight}
                      multiline
                      textAlignVertical="top"
                    />
                  </View>
                ) : tab === 'settings' ? (
                  <View>
                    {/* 自分の名前 */}
                    <Text style={styles.fieldLabel}>{t('groupDetail.myName')}</Text>
                    <TextInput
                      style={styles.memoInput}
                      value={myName}
                      onChangeText={(text) => useGroupStore.getState().setMyName(text)}
                      placeholder={t('groupDetail.namePh')}
                      placeholderTextColor={colors.textLight}
                      returnKeyType="done"
                    />
                    {/* 共有範囲設定 */}
                    <Text style={styles.fieldLabel}>{t('groupDetail.shareScope')}</Text>
                    <View style={styles.settingsCard}>
                      {([
                        { key: 'shareMain' as const, labelKey: 'groupDetail.shareMain' as const },
                        { key: 'shareMini' as const, labelKey: 'groupDetail.shareMini' as const },
                        { key: 'shareNotes' as const, labelKey: 'groupDetail.shareNotes' as const },
                        { key: 'shareTimeSchedule' as const, labelKey: 'groupDetail.shareTs' as const },
                      ] as const).map(({ key, labelKey }, idx, arr) => (
                        <TouchableOpacity
                          key={key}
                          style={[styles.settingRow, idx < arr.length - 1 && styles.settingRowBorder]}
                          onPress={() => toggleSetting(key)}
                        >
                          <Text style={styles.settingLabel}>{t(labelKey)}</Text>
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
                          <Text style={styles.syncBtnText}>{t('groupDetail.sync')}</Text>
                        </>
                      )}
                    </TouchableOpacity>

                    <View style={{ height: 8 }} />
                  </View>
                ) : (
                  /* ── スケジュールタブ ── */
                  <View style={{ flex: 1 }}>
                    {/* ビュー切り替え */}
                    <View style={styles.scheduleViewToggle}>
                      {([
                        { key: 'table' as const, labelKey: 'groupDetail.viewTable' as const, icon: 'list-outline' as const },
                        { key: 'calendar' as const, labelKey: 'groupDetail.viewCal' as const, icon: 'calendar-outline' as const },
                      ] as const).map(({ key, labelKey, icon }) => (
                        <TouchableOpacity
                          key={key}
                          style={[styles.scheduleViewTab, scheduleView === key && styles.scheduleViewTabActive]}
                          onPress={() => { hapticSelect(); setScheduleView(key); }}
                        >
                          <Ionicons name={icon} size={13} color={scheduleView === key ? colors.primary : colors.textSecondary} />
                          <Text style={[styles.scheduleViewTabText, scheduleView === key && styles.scheduleViewTabTextActive]}>{t(labelKey)}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    {scheduleError ? (
                      <View style={styles.errorBox}>
                        <Ionicons name="alert-circle-outline" size={16} color="#EF4444" />
                        <Text style={styles.errorText}>{scheduleError}</Text>
                      </View>
                    ) : tableMembers.length === 0 ? (
                      <View style={styles.emptySchedule}>
                        <Text style={styles.emptyText}>{t('groupDetail.emptySch')}</Text>
                        <Text style={styles.emptySubText}>{t('groupDetail.emptySchHint')}</Text>
                      </View>
                    ) : scheduleView === 'table' ? (
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll}>
                        <View>
                          {/* ヘッダー行 */}
                          <View style={styles.tableHeaderRow}>
                            <View style={[styles.tableCell, styles.dateCellHeader]}>
                              <Text style={styles.tableHeaderDateText}>{t('groupDetail.colDate')}</Text>
                            </View>
                            {tableMembers.map(m => (
                              <TouchableOpacity
                                key={m.id}
                                style={[styles.tableCell, styles.memberCellHeader]}
                                onPress={() => { hapticSelect(); setSelectedMemberId(m.id); }}
                              >
                                <Text style={styles.memberHeaderName} numberOfLines={1}>{m.name}</Text>
                              </TouchableOpacity>
                            ))}
                          </View>
                          {/* データ行 */}
                          {allDates.map((date, idx) => {
                            const { date: d, day, dayIdx } = formatShortDate(date);
                            const isSun = dayIdx === 0;
                            const isSat = dayIdx === 6;
                            return (
                              <View key={date} style={[styles.tableRow, idx % 2 === 1 && styles.tableRowAlt]}>
                                <View style={[styles.tableCell, styles.dateCellBody]}>
                                  <Text style={[styles.tableDateMain, isSun && { color: '#EF4444' }, isSat && { color: '#3B82F6' }]}>{d}</Text>
                                  <Text style={[styles.tableDateDay, isSun && { color: '#EF4444' }, isSat && { color: '#3B82F6' }]}>({day})</Text>
                                </View>
                                {tableMembers.map(m => {
                                  const e = entryMap[date]?.[m.id];
                                  return (
                                    <View key={m.id} style={[styles.tableCell, styles.stampCell]}>
                                      {e?.mainStampText ? (
                                        <View style={[styles.tableStampChip, { backgroundColor: e.mainStampBg ?? '#DBEAFE' }]}>
                                          <Text style={[styles.tableStampText, { color: e.mainStampTextColor ?? colors.primary }]} numberOfLines={1}>
                                            {e.mainStampText}
                                          </Text>
                                        </View>
                                      ) : e ? (
                                        <View style={styles.tableStampEmpty}>
                                          <Ionicons name="remove" size={12} color={colors.textLight} />
                                        </View>
                                      ) : (
                                        <View style={styles.tableStampNone} />
                                      )}
                                    </View>
                                  );
                                })}
                              </View>
                            );
                          })}
                        </View>
                      </ScrollView>
                    ) : (
                      /* ── カレンダービュー（メンバー一覧） ── */
                      <View style={styles.memberListContainer}>
                        {tableMembers.map((m, idx) => (
                          <TouchableOpacity
                            key={m.id}
                            style={[styles.memberListRow, idx > 0 && styles.memberListRowBorder]}
                            onPress={() => { hapticSelect(); setExpandedCalMemberId(m.id); setExpandedSelDate(null); setDetailTab('memo'); }}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.memberListName}>{m.name}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                    <View style={{ height: 8 }} />
                  </View>
                )}
                {/* フッター分の余白 */}
                <View style={{ height: FOOTER_H }} />
              </ScrollView>

              <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
                <Text style={styles.closeBtnText}>{t('groupDetail.close')}</Text>
              </TouchableOpacity>
            </View>

          {/* 拡大カレンダー（Modalネスト回避のためoverlay内に配置） */}
          {expandedCalMemberId && (() => {
            const member = tableMembers.find(m => m.id === expandedCalMemberId);
            if (!member) return null;
            const closeExpanded = () => { setExpandedCalMemberId(null); setExpandedSelDate(null); };
            const selEntry = expandedSelDate ? entryMap[expandedSelDate]?.[member.id] : null;
            const selFmt = expandedSelDate ? formatShortDate(expandedSelDate) : null;
            return (
              <View style={styles.expandedOverlay}>
                <TouchableWithoutFeedback onPress={closeExpanded}>
                  <View style={styles.expandedBg} />
                </TouchableWithoutFeedback>
                <View style={[styles.sheet, { height: SCREEN_H * 0.92, position: 'absolute', bottom: 0, left: 0, right: 0 }]}>
                  <View style={styles.handle} />
                  <View style={[styles.detailHeader, { marginBottom: 4 }]}>
                    <Text style={[styles.modalTitle, { flex: 1 }]}>{t('groupDetail.memberCal', { name: member.name })}</Text>
                    <TouchableOpacity onPress={closeExpanded}>
                      <Ionicons name="close" size={22} color={colors.textSecondary} />
                    </TouchableOpacity>
                  </View>
                  <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} nestedScrollEnabled>
                  <View style={styles.calNavRow}>
                    <TouchableOpacity onPress={prevCalMonth} style={styles.calNavBtn}>
                      <Ionicons name="chevron-back" size={20} color={colors.primary} />
                    </TouchableOpacity>
                    <Text style={styles.calNavTitle}>{formatCalendarMonthTitle(calYear, calMonth, locale)}</Text>
                    <TouchableOpacity onPress={nextCalMonth} style={styles.calNavBtn}>
                      <Ionicons name="chevron-forward" size={20} color={colors.primary} />
                    </TouchableOpacity>
                  </View>
                  <View style={styles.scWeekHeader}>
                    {sunFirstLabels.map((l, i) => (
                      <View key={i} style={[styles.scWeekHeaderCell, { width: SC_W + SC_MARGIN * 2 }]}>
                        <Text style={[styles.scWeekHeaderText, i === 0 && { color: colors.sunday }, i === 6 && { color: colors.saturday }]}>{l}</Text>
                      </View>
                    ))}
                  </View>
                  <View style={styles.scGrid}>
                    {calWeeks.map((week, wi) => (
                      <View key={wi} style={styles.scWeekRow}>
                        {week.map((day, di) => {
                          if (!day) return (
                            <View key={di} style={{ width: SC_W, height: SC_H, marginHorizontal: SC_MARGIN, marginVertical: 1 }} />
                          );
                          const dateStr = `${calYear}-${String(calMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                          const e = entryMap[dateStr]?.[member.id];
                          const isSun = di === 0, isSat = di === 6;
                          const isToday = dateStr === TODAY_STR;
                          const isSel = dateStr === expandedSelDate;
                          return (
                            <TouchableOpacity
                              key={di}
                              style={[styles.scCell, isSel && styles.scCellSelected]}
                              onPress={() => { hapticSelect(); setExpandedSelDate(isSel ? null : dateStr); setDetailTab('memo'); }}
                              activeOpacity={0.65}
                            >
                              <View style={styles.scDateRow}>
                                <View>
                                  <View style={[styles.scDateCircle, isToday && styles.scTodayCircle]}>
                                    <Text style={[styles.scDateNum, isSun && { color: colors.sunday }, isSat && { color: colors.saturday }, isToday && { fontWeight: '800' }]}>
                                      {day}
                                    </Text>
                                  </View>
                                  {e?.notes ? <View style={styles.scNotesDot} /> : null}
                                </View>
                              </View>
                              <View style={styles.scBottomBlock}>
                                <View style={styles.scMiniRow}>
                                  {e?.miniLeftBg ? (
                                    <View style={[styles.scMiniBar, { backgroundColor: e.miniLeftBg }]}>
                                      <Text style={styles.scMiniText} numberOfLines={1}>{e.miniLeftText}</Text>
                                    </View>
                                  ) : <View style={styles.scMiniBarEmpty} />}
                                  {e?.miniRightBg ? (
                                    <View style={[styles.scMiniBar, { backgroundColor: e.miniRightBg }]}>
                                      <Text style={styles.scMiniText} numberOfLines={1}>{e.miniRightText}</Text>
                                    </View>
                                  ) : <View style={styles.scMiniBarEmpty} />}
                                </View>
                                {e?.mainStampBg ? (
                                  <View style={[styles.scMainBand, { backgroundColor: e.mainStampBg }]}>
                                    <Text style={[styles.scMainBandText, { color: e.mainStampTextColor ?? colors.primary }]} numberOfLines={1}>
                                      {e.mainStampText}
                                    </Text>
                                  </View>
                                ) : <View style={styles.scMainBandEmpty} />}
                              </View>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    ))}
                  </View>
                  <View style={styles.bigCalDetailPanel}>
                    {expandedSelDate && selFmt ? (
                      <>
                        <View style={styles.detailTabHeader}>
                          <Text style={[styles.bigCalDetailDate, selFmt.dayIdx === 0 && { color: '#EF4444' }, selFmt.dayIdx === 6 && { color: '#3B82F6' }]}>
                            {selFmt.date}{locale === 'en' ? ` (${selFmt.day})` : `（${selFmt.day}）`}
                          </Text>
                          <View style={styles.detailTabGroup}>
                            {([
                              { key: 'memo' as const, labelKey: 'groupDetail.subMemo' as const },
                              { key: 'timeschedule' as const, labelKey: 'groupDetail.subTs' as const },
                            ] as const).map(({ key, labelKey }) => (
                              <TouchableOpacity
                                key={key}
                                style={[styles.detailTabBtn, detailTab === key && styles.detailTabBtnActive]}
                                onPress={() => { hapticSelect(); setDetailTab(key); }}
                              >
                                <Text style={[styles.detailTabBtnText, detailTab === key && styles.detailTabBtnTextActive]}>{t(labelKey)}</Text>
                              </TouchableOpacity>
                            ))}
                          </View>
                        </View>
                        {selEntry ? (
                          detailTab === 'memo' ? (
                            <View>
                              {selEntry.notes ? (() => {
                                const memoItems = parseNoteItems(selEntry.notes);
                                return memoItems.length > 0 ? (
                                  memoItems.map((item, i) => (
                                    <View key={i} style={styles.detailNoteRow}>
                                      {item.time ? <Text style={styles.detailNoteTime}>{item.time}</Text> : null}
                                      <Text style={[styles.detailNoteText, !item.time && { marginLeft: 0 }]}>{item.content}</Text>
                                    </View>
                                  ))
                                ) : (
                                  <Text style={[styles.emptyText, { marginTop: 8 }]}>{t('groupDetail.emptyMemo')}</Text>
                                );
                              })() : (
                                <Text style={[styles.emptyText, { marginTop: 8 }]}>{t('groupDetail.emptyMemo')}</Text>
                              )}
                              <View style={{ height: 16 }} />
                            </View>
                          ) : (
                            (() => {
                              const slots = selEntry.timeSlots ?? [];
                              if (slots.length === 0) {
                                return <Text style={[styles.emptyText, { marginTop: 8 }]}>{t('groupDetail.emptyTs')}</Text>;
                              }
                              const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
                              const allMins = slots.flatMap(s => [toMin(s.startTime), toMin(s.endTime)]);
                              const startHour = Math.max(0, Math.floor(Math.min(...allMins) / 60));
                              const endHour = Math.min(24, Math.ceil(Math.max(...allMins) / 60));
                              const totalHours = Math.max(1, endHour - startHour);
                              const TS_HOUR_H = 34;
                              const TS_LABEL_W = 38;
                              const contentH = totalHours * TS_HOUR_H;
                              const visibleH = 8 * TS_HOUR_H; // 8時間分を常に表示
                              const hours = Array.from({ length: totalHours + 1 }, (_, i) => i + startHour);
                              return (
                                <ScrollView
                                  style={{ height: visibleH }}
                                  nestedScrollEnabled
                                  showsVerticalScrollIndicator={false}
                                  scrollEnabled={contentH > visibleH}
                                >
                                  <View style={{ position: 'relative', height: Math.max(contentH, visibleH) }}>
                                    {hours.map(h => (
                                      <View key={h} style={[styles.tsHourRow, { top: (h - startHour) * TS_HOUR_H, height: TS_HOUR_H }]}>
                                        <TimelineHourLabel hour={h} style={[styles.tsHourLabel, { width: TS_LABEL_W }]} />
                                        <View style={[styles.tsHourLine, { height: TS_HOUR_H }]} />
                                      </View>
                                    ))}
                                    {slots.map(slot => {
                                      const startM = toMin(slot.startTime) - startHour * 60;
                                      const endM = toMin(slot.endTime) - startHour * 60;
                                      const top = (startM / 60) * TS_HOUR_H;
                                      const height = Math.max(((endM - startM) / 60) * TS_HOUR_H, 16);
                                      return (
                                        <View key={slot.id} style={[styles.tsEventBlock, { top, height, left: TS_LABEL_W + 4, backgroundColor: slot.color }]}>
                                          <Text style={styles.tsEventTitle} numberOfLines={1}>{slot.title}</Text>
                                          {height >= 28 && (
                                          <Text style={styles.tsEventTime}>
                                            {slot.startTime}{locale === 'en' ? '–' : '〜'}{slot.endTime}
                                          </Text>
                                        )}
                                        </View>
                                      );
                                    })}
                                  </View>
                                </ScrollView>
                              );
                            })()
                          )
                        ) : (
                          <Text style={[styles.emptyText, { marginTop: 12 }]}>{t('groupDetail.emptyDay')}</Text>
                        )}
                      </>
                    ) : (
                      <Text style={styles.bigCalDetailHint}>{t('groupDetail.tapHint')}</Text>
                    )}
                  </View>
                  </ScrollView>
                </View>
              </View>
            );
          })()}
        </View>
    </Modal>

    {/* メンバー詳細モーダル */}
    {selectedMemberId && (() => {
      const member = tableMembers.find(m => m.id === selectedMemberId);
      if (!member) return null;
      return (
        <Modal transparent animationType="slide" visible={!!selectedMemberId} onRequestClose={() => setSelectedMemberId(null)} statusBarTranslucent>
          <TouchableWithoutFeedback onPress={() => setSelectedMemberId(null)}>
            <View style={styles.overlay}>
              <TouchableWithoutFeedback onPress={() => {}}>
                <View style={[styles.sheet, { height: SCREEN_H * 0.75 }]}>
                  <View style={styles.handle} />
                  <View style={styles.detailHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modalTitle}>{member.name}</Text>
                      <Text style={styles.subText}>{t('groupDetail.daysCount', { n: selectedMemberEntries.length })}</Text>
                    </View>
                    <TouchableOpacity onPress={() => setSelectedMemberId(null)}>
                      <Ionicons name="close" size={22} color={colors.textSecondary} />
                    </TouchableOpacity>
                  </View>
                  <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
                    {selectedMemberEntries.map((e, idx) => {
                      const { date: d, day, dayIdx } = formatShortDate(e.date);
                      const isSun = dayIdx === 0;
                      const isSat = dayIdx === 6;
                      return (
                        <View key={e.date} style={[styles.memberDetailRow, idx > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
                          <View style={styles.memberDetailDate}>
                            <Text style={[styles.memberDetailDateMain, isSun && { color: '#EF4444' }, isSat && { color: '#3B82F6' }]}>{d}</Text>
                            <Text style={[styles.memberDetailDateDay, isSun && { color: '#EF4444' }, isSat && { color: '#3B82F6' }]}>({day})</Text>
                          </View>
                          <View style={styles.memberDetailStamps}>
                            {e.miniLeftText && (
                              <View style={[styles.miniChip, { backgroundColor: e.miniLeftBg ?? '#EFF6FF' }]}>
                                <Text style={styles.miniChipText}>{e.miniLeftText}</Text>
                              </View>
                            )}
                            {e.miniRightText && (
                              <View style={[styles.miniChip, { backgroundColor: e.miniRightBg ?? '#EFF6FF' }]}>
                                <Text style={styles.miniChipText}>{e.miniRightText}</Text>
                              </View>
                            )}
                            {e.mainStampText && (
                              <View style={[styles.mainChip, { backgroundColor: e.mainStampBg ?? '#DBEAFE' }]}>
                                <Text style={[styles.mainChipText, { color: e.mainStampTextColor ?? colors.primary }]}>{e.mainStampText}</Text>
                              </View>
                            )}
                            {e.notes && (
                              <Text style={styles.memberDetailNote}>{e.notes}</Text>
                            )}
                          </View>
                        </View>
                      );
                    })}
                    <View style={{ height: 24 }} />
                  </ScrollView>
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>
      );
    })()}
    </>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, flexDirection: 'column', backgroundColor: 'rgba(15,23,42,0.45)' },
  backdropTap: { flex: 1 },
  expandedOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
  expandedBg: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,23,42,0.45)' },
  sheet: {
    height: SCREEN_H * 0.88,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingBottom: FOOTER_H,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#BFDBFE', alignSelf: 'center', marginTop: 10, marginBottom: 10 },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  groupHeaderIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  groupHeaderIconImage: { width: 44, height: 44, borderRadius: 14, resizeMode: 'cover' },
  groupHeaderEmoji: { fontSize: 22 },
  groupNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  editBtn: { padding: 6, borderRadius: 10, backgroundColor: '#F5EFF5' },
  groupNameInput: { fontSize: 18, fontWeight: '800', color: colors.text, borderBottomWidth: 2, borderBottomColor: colors.primary, paddingBottom: 2, paddingRight: 8 },
  detailEmoji: { fontSize: 36 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  subText: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },

  tabRow: { flexDirection: 'row', backgroundColor: '#F5EFF5', borderRadius: 12, padding: 3, marginBottom: 14 },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center' },
  tabActive: { backgroundColor: '#FFFFFF', shadowColor: '#3B82F6', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 4, elevation: 2 },
  tabText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  tabTextActive: { color: colors.primary, fontWeight: '800' },

  scroll: { flex: 1 },
  fieldLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginTop: 14, marginBottom: 8 },
  iconEditRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#F8F4FC', borderRadius: 16, padding: 12 },
  iconPreview: { width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  iconPreviewImage: { width: 56, height: 56, borderRadius: 18, resizeMode: 'cover' },
  iconPreviewEmoji: { fontSize: 26 },
  iconEditBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#EFF6FF', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, alignSelf: 'flex-start' },
  iconEditBtnSecondary: { backgroundColor: '#F5EFF5', marginTop: 8 },
  iconEditBtnText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  iconHint: { fontSize: 11, color: colors.textLight, marginTop: 8 },

  inviteCodeRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5EFF5', borderRadius: 12, padding: 14, gap: 12 },
  inviteCodeLabel: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  inviteCode: { fontSize: 20, fontWeight: '800', color: colors.primary, letterSpacing: 3 },
  shareBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  shareBtnText: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },

  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  memberName: { fontSize: 14, fontWeight: '600', color: colors.text, flex: 1 },
  ownerBadge: { backgroundColor: '#DBEAFE', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  ownerText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  avatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFFFFF' },
  avatarText: { fontSize: 11, fontWeight: '700', color: '#FFFFFF' },
  memoInput: { borderWidth: 2, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: colors.text, minHeight: 80, textAlignVertical: 'top' },

  // 共有設定
  settingsCard: { backgroundColor: '#F8F4FC', borderRadius: 16, overflow: 'hidden' },
  settingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, gap: 10 },
  settingRowBorder: { borderBottomWidth: 1, borderBottomColor: '#EFF6FF' },
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
  noteChip: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#EFF6FF', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, maxWidth: 150 },
  noteChipText: { fontSize: 10, color: colors.textSecondary, flexShrink: 1 },

  closeBtn: { backgroundColor: colors.primary, borderRadius: 14, height: FOOTER_H, alignItems: 'center', justifyContent: 'center', marginTop: 10, shadowColor: colors.primary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 3 },
  closeBtnText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FFF0F0', borderRadius: 10, padding: 12, marginBottom: 8 },
  errorText: { flex: 1, fontSize: 13, color: '#EF4444', fontWeight: '600' },

  // テーブルビュー
  tableScroll: { marginHorizontal: -4 },
  tableHeaderRow: { flexDirection: 'row', borderBottomWidth: 2, borderBottomColor: colors.primaryLight, paddingBottom: 6, marginBottom: 2 },
  tableRow: { flexDirection: 'row', minHeight: 44, alignItems: 'center' },
  tableRowAlt: { backgroundColor: '#F8FAFF' },
  tableCell: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4 },
  dateCellHeader: { width: DATE_COL_W, alignItems: 'flex-start', paddingLeft: 4 },
  dateCellBody: { width: DATE_COL_W, alignItems: 'flex-start', paddingLeft: 4, paddingVertical: 8 },
  memberCellHeader: { width: MEMBER_COL_W, gap: 4 },
  tableHeaderDateText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  memberHeaderDot: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  memberHeaderDotText: { fontSize: 12, fontWeight: '800', color: '#FFFFFF' },
  memberHeaderName: { fontSize: 11, fontWeight: '700', color: colors.text, maxWidth: MEMBER_COL_W - 8, textAlign: 'center' },
  tableDateMain: { fontSize: 13, fontWeight: '700', color: colors.text },
  tableDateDay: { fontSize: 11, color: colors.textSecondary },
  stampCell: { width: MEMBER_COL_W },
  tableStampChip: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 4, minWidth: 30, maxWidth: MEMBER_COL_W - 8, alignItems: 'center' },
  tableStampText: { fontSize: 11, fontWeight: '800', textAlign: 'center' },
  tableStampEmpty: { width: 20, height: 20, borderRadius: 4, backgroundColor: '#F1F5F9', alignItems: 'center', justifyContent: 'center' },
  tableStampNone: { width: 8, height: 2, backgroundColor: '#E2E8F0', borderRadius: 1 },

  // スケジュールビュー切り替え
  scheduleViewToggle: { flexDirection: 'row', backgroundColor: '#F0EDF8', borderRadius: 10, padding: 3, marginBottom: 10 },
  scheduleViewTab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 6, borderRadius: 8 },
  scheduleViewTabActive: { backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 1 },
  scheduleViewTabText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  scheduleViewTabTextActive: { color: colors.primary, fontWeight: '700' },

  // カレンダーナビ
  calNavRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  calNavBtn: { padding: 6 },
  calNavTitle: { fontSize: 15, fontWeight: '800', color: colors.text },

  // ミニカレンダー
  miniCalGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: MINI_CAL_GAP },
  miniCalCard: { width: MINI_CAL_W, backgroundColor: '#FAFAFA', borderRadius: 12, padding: 8, overflow: 'hidden', borderWidth: 1, borderColor: '#E5E7EB' },
  miniCalMemberName: { fontSize: 11, fontWeight: '800', color: colors.text, marginBottom: 4 },
  miniCalWeekRow: { flexDirection: 'row' },
  miniCalWeekLabel: { fontSize: 7, fontWeight: '600', textAlign: 'center', color: colors.textSecondary, paddingVertical: 2 },
  miniCalCell: { alignItems: 'center', justifyContent: 'space-between', paddingTop: 2, paddingBottom: 1 },
  miniCalDayNum: { fontSize: 8, fontWeight: '500', color: colors.text, lineHeight: 10 },
  miniCalStampStrip: { width: '100%', height: 3, borderRadius: 1 },
  miniCalCellToday: { backgroundColor: colors.primary, borderRadius: 3 },
  miniCalTodayText: { color: '#FFFFFF', fontWeight: '800' },

  // 共有カレンダー（DayCellと同じ構造・サイズ）
  scWeekHeader: { flexDirection: 'row', backgroundColor: '#FAFAFA', borderBottomWidth: 1, borderBottomColor: '#EEE5F5', paddingVertical: 6 },
  scWeekHeaderCell: { alignItems: 'center' },
  scWeekHeaderText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  scGrid: { backgroundColor: '#F0EBF8', paddingVertical: 1 },
  scWeekRow: { flexDirection: 'row' },
  scCell: {
    width: SC_W, height: SC_H,
    marginHorizontal: SC_MARGIN, marginVertical: 1,
    alignItems: 'flex-start', justifyContent: 'space-between',
    paddingTop: 4, paddingBottom: 0,
    borderRadius: 6, backgroundColor: '#FFFFFF', overflow: 'hidden',
  },
  scCellSelected: { backgroundColor: '#FFF0F8' },
  scDateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingRight: 3 },
  scDateCircle: { width: 24, height: 24, borderRadius: 4, alignItems: 'center', justifyContent: 'center', marginLeft: 3 },
  scTodayCircle: { backgroundColor: '#D9D9D9', borderRadius: 12 },
  scDateNum: { fontSize: 12, fontWeight: '600', color: colors.text, lineHeight: 14 },
  scNotesDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#FFB3CC', marginLeft: 3, marginTop: -4 },
  scBottomBlock: { width: '100%', flexDirection: 'column' },
  scMiniRow: { flexDirection: 'row', width: '100%', height: 15 },
  scMiniBar: { flex: 1, height: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', opacity: 0.55 },
  scMiniBarEmpty: { flex: 1, height: 15 },
  scMiniText: { fontSize: 10, fontWeight: '400', textAlign: 'center', letterSpacing: -0.5, color: colors.text },
  scMainBand: { width: '100%', height: 22, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  scMainBandEmpty: { width: '100%', height: 22 },
  scMainBandText: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },

  // 旧ビッグカレンダー（不要だが参照残し）
  bigCalNotesDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.primary, position: 'absolute', top: 3, right: 3 },

  // メンバーリスト（カレンダータブ）
  memberListContainer: { backgroundColor: '#F8F4FC', borderRadius: 14, overflow: 'hidden' },
  memberListRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 16 },
  memberListRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DDD5EE' },
  memberListName: { fontSize: 15, fontWeight: '600', color: colors.text },
  bigCalDetailPanel: { borderTopWidth: 1, borderTopColor: colors.divider, marginTop: 8, paddingTop: 10, paddingBottom: 40 },
  bigCalDetailDate: { fontSize: 14, fontWeight: '800', color: colors.text },
  bigCalDetailHint: { fontSize: 13, color: colors.textLight, marginTop: 8 },

  // 詳細タブ
  detailTabHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  detailTabGroup: { flexDirection: 'row', backgroundColor: '#F0EDF8', borderRadius: 8, padding: 2 },
  detailTabBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7 },
  detailTabBtnActive: { backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 2, elevation: 1 },
  detailTabBtnText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  detailTabBtnTextActive: { color: colors.primary, fontWeight: '700' },

  // スタンプタブ
  detailStampArea: { gap: 10 },
  detailMiniRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  detailSectionLabel: { fontSize: 11, fontWeight: '600', color: colors.textSecondary, width: 28 },
  detailMiniChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  detailMiniChipText: { fontSize: 14, fontWeight: '700', color: colors.text },
  detailMainBand: { borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  detailMainBandText: { fontSize: 20, fontWeight: '800' },

  // 予定・メモタブ
  detailNoteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
  detailNoteTime: { fontSize: 13, fontWeight: '700', color: colors.primary, width: 110 },
  detailNoteText: { flex: 1, fontSize: 14, color: colors.text, lineHeight: 20 },
  detailTimeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
  detailTimeLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, width: 110 },
  detailTimeContent: { flex: 1, fontSize: 14, color: colors.text, lineHeight: 20 },
  // タイムライン
  tsHourRow: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'flex-start', borderTopWidth: 0.5, borderTopColor: '#D4C8E8' },
  tsHourLabel: { fontSize: 9, color: colors.textLight, fontWeight: '500', paddingLeft: 2, marginTop: -5 },
  tsHourLine: { flex: 1, borderLeftWidth: 0.5, borderLeftColor: '#E5DCF0', height: 20 },
  tsEventBlock: { position: 'absolute', right: 6, borderRadius: 7, paddingHorizontal: 7, paddingVertical: 3, zIndex: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 3, elevation: 2 },
  tsEventTitle: { fontSize: 12, fontWeight: '700', color: '#FFFFFF' },
  tsEventTime: { fontSize: 10, color: 'rgba(255,255,255,0.9)', marginTop: 1 },

  // メンバー詳細
  memberDetailRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 12, gap: 12 },
  memberDetailDate: { width: 56, alignItems: 'flex-start' },
  memberDetailDateMain: { fontSize: 14, fontWeight: '700', color: colors.text },
  memberDetailDateDay: { fontSize: 11, color: colors.textSecondary },
  memberDetailStamps: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  memberDetailNote: { fontSize: 12, color: colors.textSecondary, backgroundColor: '#EFF6FF', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
});
