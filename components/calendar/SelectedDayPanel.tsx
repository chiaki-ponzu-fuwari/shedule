import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useCalendarStore } from '../../store/calendarStore';
import { useStampStore } from '../../store/stampStore';
import { formatFullDate, parseDate } from '../../utils/dateUtils';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import { NoteItem } from '../../types';

interface Props {
  date: string;
}

export function SelectedDayPanel({ date }: Props) {
  const { t, locale } = useTranslation();
  const entries = useCalendarStore((s) => s.entries);
  const setNoteItems = useCalendarStore((s) => s.setNoteItems);
  const specialDates = useCalendarStore((s) => s.specialDates);

  const getStamp = useStampStore((s) => s.getStamp);

  const entry = entries[date];
  const d = parseDate(date);

  const getEffectiveStampId = (position: 'main' | 'mini-left' | 'mini-right') => {
    if (position === 'main') return entry?.mainStampId;
    if (position === 'mini-left') return entry?.miniStamps?.left;
    return entry?.miniStamps?.right;
  };

  const mainStamp = getStamp(getEffectiveStampId('main') ?? '');
  const leftMini = getStamp(getEffectiveStampId('mini-left') ?? '');
  const rightMini = getStamp(getEffectiveStampId('mini-right') ?? '');
  const daySpecials = specialDates.filter((sd) => sd.month === d.getMonth() + 1 && sd.day === d.getDate());

  // NoteItems（旧string[]も移行）
  const noteItems: NoteItem[] = (entry?.noteItems ?? []).map((item: any, i: number) =>
    typeof item === 'string' ? { id: `m_${i}`, text: item } : item
  );
  const hasNoteItems = noteItems.length > 0;

  const toggleNotif = (idx: number) => {
    const next = noteItems.map((item, i) =>
      i === idx ? { ...item, notificationEnabled: !item.notificationEnabled } : item
    );
    setNoteItems(date, next);
  };

  const openUrl = (url: string) => {
    const normalized = url.startsWith('http') ? url : `https://${url}`;
    Linking.openURL(normalized).catch(() => {});
  };

  return (
    <View style={styles.container}>
      {/* ヘッダー */}
      <View style={styles.header}>
        <Text style={styles.dateLabel}>{formatFullDate(date, locale)}</Text>
      </View>

      <ScrollView
        horizontal={false}
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {/* メモ・予定リスト */}
        {hasNoteItems && noteItems.map((item, idx) => (
          <TouchableOpacity
            key={item.id ?? idx}
            style={styles.noteRow}
            onPress={() => item.url ? openUrl(item.url) : undefined}
            activeOpacity={item.url ? 0.7 : 1}
          >
            {/* 通知アイコン（固定幅） */}
            <TouchableOpacity
              style={styles.notifCol}
              onPress={() => toggleNotif(idx)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Ionicons
                name={item.notificationEnabled ? 'notifications' : 'notifications-outline'}
                size={15}
                color={item.notificationEnabled ? colors.primary : colors.textLight}
              />
            </TouchableOpacity>
            {/* 時間（固定幅：開始〜終了 or 開始のみ） */}
            <Text style={styles.timeCol}>
              {item.time
                ? item.endTime
                  ? `${item.time}${locale === 'en' ? '–' : '〜'}${item.endTime}`
                  : item.time
                : ''}
            </Text>
            {/* 内容 */}
            <Text style={styles.contentText} numberOfLines={1}>{item.text}</Text>
            {/* Googleカレンダーマーク */}
            {item.fromGoogleId ? (
              <View style={styles.gBadge}><Text style={styles.gBadgeText}>G</Text></View>
            ) : null}
            {/* URLリンクアイコン */}
            {item.url ? (
              <Ionicons name="link" size={13} color={colors.primary} style={styles.linkIcon} />
            ) : null}
          </TouchableOpacity>
        ))}

        {/* 旧notesフォールバック */}
        {!hasNoteItems && entry?.notes ? (
          <View style={styles.notesBox}>
            <Text style={styles.notesText} numberOfLines={2}>{entry.notes}</Text>
          </View>
        ) : null}

        {/* 誕生日・記念日 */}
        {daySpecials.map((sd) => (
          <View key={sd.id} style={[styles.specialItem, { borderLeftColor: sd.color }]}>
            <Ionicons name={(sd.emoji as any) || 'gift-outline'} size={13} color={sd.color} />
            <Text style={[styles.specialText, { color: sd.color }]}>{sd.name}</Text>
          </View>
        ))}

        {/* 何もない日 */}
        {!mainStamp && !leftMini && !rightMini && !entry?.notes && !hasNoteItems && daySpecials.length === 0 && (
          <Text style={styles.emptyText}>{t('selected.empty')}</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#DBEAFE',
    paddingHorizontal: 16,
    // 予定メモ欄を少し下げる（約3mm相当）
    paddingTop: 22,
    paddingBottom: 12,
    height: 188,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  dateLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.primary,
  },
  scroll: { flex: 1 },
  scrollContent: { gap: 5 },

  // 予定行（列揃え）
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  notifCol: {
    width: 22,
    alignItems: 'center',
  },
  timeCol: {
    width: 104,
    fontSize: 13,
    fontWeight: '600',
    color: colors.primary,
    lineHeight: 19,
    marginLeft: 4,
  },
  contentText: {
    flex: 1,
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
  },
  linkIcon: {
    marginLeft: 4,
  },
  gBadge: {
    backgroundColor: '#4285F4',
    borderRadius: 4,
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  gBadgeText: {
    fontSize: 9,
    fontWeight: '900',
    color: '#FFFFFF',
  },

  notesBox: { backgroundColor: '#EFF6FF', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  notesText: { flex: 1, fontSize: 15, color: colors.text, lineHeight: 21 },
  specialItem: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#EFF6FF', borderRadius: 8,
    paddingVertical: 5, paddingHorizontal: 8, borderLeftWidth: 3,
  },
  specialText: { fontSize: 14, fontWeight: '700' },
  emptyText: { fontSize: 15, color: colors.textLight },
});
