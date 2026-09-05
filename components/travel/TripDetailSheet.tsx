import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import {
  Alert,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import { useTripStore } from '../../store/tripStore';
import type { Trip, TripItem } from '../../types/travel';
import { formatFullDate, formatMonthDay } from '../../utils/dateUtils';
import { normalizeSafeUrl } from '../../utils/safeUrl';
import { TripItemFormSheet } from './TripItemFormSheet';
import { ITEM_ICON_NAMES, itemTypeLabelKey } from './travelPresentation';

interface Props {
  visible: boolean;
  trip: Trip | undefined;
  onClose(): void;
  onEdit(): void;
}

function formatItemTime(item: TripItem, locale: 'ja' | 'en') {
  if (item.allDay || !item.startsAtUtc) return '';
  const formatter = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    timeZone: item.departureTimezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const start = formatter.format(new Date(item.startsAtUtc));
  if (!item.endsAtUtc) return start;
  const end = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    timeZone: item.arrivalTimezone ?? item.departureTimezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(item.endsAtUtc));
  const arrivalDate = item.arrivalLocalDate && item.arrivalLocalDate !== item.localDate
    ? `${formatMonthDay(item.arrivalLocalDate, locale)} `
    : '';
  return `${start} – ${arrivalDate}${end}`;
}

function itemHeading(item: TripItem, fallback: string) {
  if (item.departure || item.arrival) {
    return [item.departure, item.arrival].filter(Boolean).join(' → ');
  }
  return item.place || item.memo || fallback;
}

export function TripDetailSheet({ visible, trip, onClose, onEdit }: Props) {
  const { t, locale } = useTranslation();
  const allItems = useTripStore((state) => state.items);
  const deleteTrip = useTripStore((state) => state.deleteTrip);
  const [itemFormVisible, setItemFormVisible] = useState(false);
  const [editingItem, setEditingItem] = useState<TripItem | undefined>();
  const items = useMemo(
    () => allItems.filter((item) => item.tripId === trip?.id),
    [allItems, trip?.id],
  );

  if (!trip) return null;

  const openNewItem = () => {
    setEditingItem(undefined);
    setItemFormVisible(true);
  };

  const openItem = (item: TripItem) => {
    setEditingItem(item);
    setItemFormVisible(true);
  };

  const confirmDelete = () => {
    Alert.alert(t('travel.deleteTripTitle'), t('travel.deleteTripBody', { title: trip.title }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          deleteTrip(trip.id);
          onClose();
        },
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.page}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('common.close')} onPress={onClose} style={styles.iconButton}>
            <Ionicons name="chevron-down" size={22} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.headerActions}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('travel.editTrip')} onPress={onEdit} style={styles.iconButton}>
              <Ionicons name="pencil-outline" size={20} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('travel.deleteTrip')} onPress={confirmDelete} style={styles.iconButton}>
              <Ionicons name="trash-outline" size={20} color="#B91C1C" />
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <View style={styles.tripHeading}>
            <View style={[styles.colorMarker, { backgroundColor: trip.color }]} />
            <View style={styles.headingCopy}>
              <Text accessibilityRole="header" style={styles.title}>{trip.title}</Text>
              <Text style={styles.period}>
                {formatFullDate(trip.startDate, locale)}
                {'\n'}
                {formatFullDate(trip.endDate, locale)}
              </Text>
            </View>
          </View>
          {trip.memo ? <Text style={styles.tripMemo}>{trip.memo}</Text> : null}

          <View style={styles.itineraryHeader}>
            <Text style={styles.sectionTitle}>{t('travel.itinerary')}</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('travel.addItinerary')} onPress={openNewItem} style={styles.addItemButton}>
              <Ionicons name="add" size={18} color={colors.textInverse} />
              <Text style={styles.addItemLabel}>{t('travel.addItinerary')}</Text>
            </TouchableOpacity>
          </View>

          {items.length === 0 ? (
            <View style={styles.emptyItinerary}>
              <Ionicons name="map-outline" size={26} color={colors.primary} />
              <Text style={styles.emptyTitle}>{t('travel.itineraryEmpty')}</Text>
              <Text style={styles.emptyBody}>{t('travel.itineraryEmptyBody')}</Text>
            </View>
          ) : (
            <View style={styles.timeline}>
              {items.map((item, index) => {
                const typeLabel = t(itemTypeLabelKey(item.type));
                return (
                  <View key={item.id} style={styles.itemRow}>
                    <View style={styles.timelineRail}>
                      <View style={[styles.timelineDot, { borderColor: trip.color }]}>
                        <Ionicons name={ITEM_ICON_NAMES[item.type]} size={13} color={trip.color} />
                      </View>
                      {index < items.length - 1 ? <View style={[styles.timelineLine, { backgroundColor: trip.color }]} /> : null}
                    </View>
                    <View style={styles.itemCard}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`${typeLabel}: ${itemHeading(item, typeLabel)}`}
                        onPress={() => openItem(item)}
                        style={[styles.itemCardButton, item.url && styles.itemCardButtonWithLink]}
                      >
                        <View style={styles.itemMetaRow}>
                          <Text style={styles.itemDate}>{formatFullDate(item.localDate, locale)}</Text>
                          <Text style={styles.itemType}>{typeLabel}</Text>
                        </View>
                        <Text style={styles.itemTitle} numberOfLines={2}>{itemHeading(item, typeLabel)}</Text>
                        {formatItemTime(item, locale) ? <Text style={styles.itemDetail}>{formatItemTime(item, locale)}</Text> : null}
                        {item.reservationNumber ? (
                          <Text style={styles.itemDetail}>{t('travel.reservation')}: {item.reservationNumber}</Text>
                        ) : null}
                        <Ionicons name="chevron-forward" size={16} color={colors.textLight} style={styles.itemChevron} />
                      </TouchableOpacity>
                      {item.url ? (
                        <TouchableOpacity
                          accessibilityRole="link"
                          onPress={() => {
                            const safe = normalizeSafeUrl(item.url ?? '');
                            if (safe) void Linking.openURL(safe);
                          }}
                          style={styles.link}
                        >
                          <Ionicons name="link-outline" size={14} color={colors.primary} />
                          <Text style={styles.linkLabel}>{t('travel.openLink')}</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>

        <TripItemFormSheet
          visible={itemFormVisible}
          trip={trip}
          item={editingItem}
          onClose={() => setItemFormVisible(false)}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingTop: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.card,
  },
  headerActions: { flexDirection: 'row' },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 48 },
  tripHeading: { flexDirection: 'row', gap: 14 },
  colorMarker: { width: 5, minHeight: 82, borderRadius: 3 },
  headingCopy: { flex: 1 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800', lineHeight: 31 },
  period: { marginTop: 8, color: colors.textSecondary, fontSize: 13, fontWeight: '600', lineHeight: 21 },
  tripMemo: { marginTop: 16, color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
  itineraryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 30, marginBottom: 14 },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  addItemButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 13, borderRadius: 13, backgroundColor: colors.primary },
  addItemLabel: { color: colors.textInverse, fontSize: 13, fontWeight: '800' },
  emptyItinerary: { alignItems: 'center', paddingHorizontal: 20, paddingVertical: 34, borderWidth: 1, borderColor: colors.border, borderRadius: 16, backgroundColor: colors.card },
  emptyTitle: { marginTop: 10, color: colors.text, fontSize: 15, fontWeight: '800' },
  emptyBody: { marginTop: 5, color: colors.textSecondary, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  timeline: { gap: 0 },
  itemRow: { minHeight: 102, flexDirection: 'row' },
  timelineRail: { width: 38, alignItems: 'center' },
  timelineDot: { width: 28, height: 28, zIndex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderRadius: 14, backgroundColor: colors.card },
  timelineLine: { position: 'absolute', top: 27, bottom: -2, width: 2, opacity: 0.28 },
  itemCard: { flex: 1, minHeight: 88, marginBottom: 14, borderRadius: 14, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  itemCardButton: { minHeight: 86, padding: 13, paddingRight: 34 },
  itemCardButtonWithLink: { minHeight: 64, paddingBottom: 2 },
  itemMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  itemDate: { flex: 1, color: colors.textSecondary, fontSize: 11, fontWeight: '700' },
  itemType: { color: colors.primary, fontSize: 11, fontWeight: '800' },
  itemTitle: { marginTop: 7, color: colors.text, fontSize: 15, fontWeight: '800', lineHeight: 20 },
  itemDetail: { marginTop: 5, color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  link: { minHeight: 36, flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 5, marginLeft: 13, marginBottom: 4 },
  linkLabel: { color: colors.primary, fontSize: 12, fontWeight: '700' },
  itemChevron: { position: 'absolute', top: '50%', right: 10 },
});
