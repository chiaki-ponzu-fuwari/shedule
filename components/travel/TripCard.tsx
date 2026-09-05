import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import type { Trip, TripItem } from '../../types/travel';
import { formatMonthDay } from '../../utils/dateUtils';
import { ITEM_ICON_NAMES, TRANSPORT_ICON_NAMES, itemTypeLabelKey, transportLabelKey } from './travelPresentation';

interface Props {
  trip: Trip;
  nextItem?: TripItem;
  onPress(): void;
}

export function TripCard({ trip, nextItem, onPress }: Props) {
  const { t, locale } = useTranslation();
  const startLabel = t(transportLabelKey(trip.startIcon));
  const endLabel = t(transportLabelKey(trip.endIcon));
  const startTransportLabel = t('travel.endpoint.start', { transport: startLabel });
  const endTransportLabel = t('travel.endpoint.end', { transport: endLabel });

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`${trip.title}, ${formatMonthDay(trip.startDate, locale)} - ${formatMonthDay(trip.endDate, locale)}, ${startTransportLabel}, ${endTransportLabel}`}
      activeOpacity={0.75}
      onPress={onPress}
      style={styles.card}
    >
      <View style={[styles.routeBar, { backgroundColor: trip.color }]} />
      <View style={styles.content}>
        <View style={styles.topRow}>
          <Text style={styles.title} numberOfLines={2}>{trip.title}</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textLight} />
        </View>

        <View style={styles.periodRow}>
          <View style={styles.transportMark}>
            <Ionicons name={TRANSPORT_ICON_NAMES[trip.startIcon]} size={12} color={trip.color} />
          </View>
          <Text style={styles.period}>
            {formatMonthDay(trip.startDate, locale)}
            {'  —  '}
            {formatMonthDay(trip.endDate, locale)}
          </Text>
          <View style={styles.transportMark}>
            <Ionicons name={TRANSPORT_ICON_NAMES[trip.endIcon]} size={12} color={trip.color} />
          </View>
        </View>

        {nextItem ? (
          <View style={styles.nextRow}>
            <Ionicons name={ITEM_ICON_NAMES[nextItem.type]} size={14} color={colors.textSecondary} />
            <Text style={styles.nextText} numberOfLines={1}>
              {t('travel.next')}: {t(itemTypeLabelKey(nextItem.type))}
              {nextItem.place ? ` · ${nextItem.place}` : ''}
              {nextItem.departure ? ` · ${nextItem.departure}` : ''}
            </Text>
          </View>
        ) : (
          <Text style={styles.noItinerary}>{t('travel.noItinerary')}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 132,
    flexDirection: 'row',
    overflow: 'hidden',
    borderRadius: 18,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  routeBar: { width: 5 },
  content: { flex: 1, paddingHorizontal: 16, paddingVertical: 15 },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  title: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '800', lineHeight: 23 },
  periodRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 10 },
  transportMark: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11,
    backgroundColor: colors.primaryBg,
  },
  period: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  nextRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 12 },
  nextText: { flex: 1, color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  noItinerary: { marginTop: 12, color: colors.textLight, fontSize: 12, fontWeight: '600' },
});
