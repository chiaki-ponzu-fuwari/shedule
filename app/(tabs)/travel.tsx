import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { TripCard } from '../../components/travel/TripCard';
import { TripDetailSheet } from '../../components/travel/TripDetailSheet';
import { TripFormSheet } from '../../components/travel/TripFormSheet';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import { useTripStore } from '../../store/tripStore';
import type { Trip } from '../../types/travel';
import { formatDate } from '../../utils/dateUtils';
import { sortTrips } from '../../utils/tripUtils';

type TripGroup = 'active' | 'upcoming' | 'past';

function groupForTrip(trip: Trip, today: string): TripGroup {
  if (trip.startDate <= today && trip.endDate >= today) return 'active';
  return trip.startDate > today ? 'upcoming' : 'past';
}

export default function TravelScreen() {
  const { t } = useTranslation();
  const trips = useTripStore((state) => state.trips);
  const items = useTripStore((state) => state.items);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [tripFormVisible, setTripFormVisible] = useState(false);
  const [editingTripId, setEditingTripId] = useState<string | null>(null);
  const today = formatDate(new Date());

  const sortedTrips = useMemo(() => sortTrips(trips, today), [today, trips]);
  const groups = useMemo(() => {
    const result: Record<TripGroup, Trip[]> = { active: [], upcoming: [], past: [] };
    sortedTrips.forEach((trip) => result[groupForTrip(trip, today)].push(trip));
    return result;
  }, [sortedTrips, today]);
  const selectedTrip = trips.find((trip) => trip.id === selectedTripId);
  const editingTrip = trips.find((trip) => trip.id === editingTripId);

  const openAdd = () => {
    setEditingTripId(null);
    setTripFormVisible(true);
  };

  const openEdit = () => {
    if (!selectedTrip) return;
    setEditingTripId(selectedTrip.id);
    setSelectedTripId(null);
    setTripFormVisible(true);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View>
          <Text accessibilityRole="header" style={styles.screenTitle}>{t('travel.title')}</Text>
          <Text style={styles.tagline}>{t('travel.tagline')}</Text>
        </View>
        {trips.length > 0 ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('travel.addTrip')} onPress={openAdd} style={styles.headerAdd}>
            <Ionicons name="add" size={22} color={colors.primary} />
          </TouchableOpacity>
        ) : null}
      </View>

      {trips.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.routeIllustration} accessible={false}>
            <View style={[styles.routeDot, styles.routeDotStart]} />
            <View style={styles.routeLine} />
            <Ionicons name="airplane" size={14} color={colors.primary} />
          </View>
          <Text style={styles.emptyTitle}>{t('travel.emptyTitle')}</Text>
          <Text style={styles.emptyBody}>{t('travel.emptyBody')}</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('travel.addTrip')} onPress={openAdd} style={styles.primaryButton}>
            <Ionicons name="add" size={19} color={colors.textInverse} />
            <Text style={styles.primaryLabel}>{t('travel.addTrip')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.list}>
          {(['active', 'upcoming', 'past'] as const).map((group) => groups[group].length > 0 ? (
            <View key={group} style={styles.group}>
              <Text style={styles.groupTitle}>{t(`travel.group.${group}`)}</Text>
              <View style={styles.cards}>
                {groups[group].map((trip) => (
                  <TripCard
                    key={trip.id}
                    trip={trip}
                    nextItem={items.find((item) => item.tripId === trip.id && item.localDate >= today)
                      ?? items.find((item) => item.tripId === trip.id)}
                    onPress={() => setSelectedTripId(trip.id)}
                  />
                ))}
              </View>
            </View>
          ) : null)}
        </ScrollView>
      )}

      <TripFormSheet
        visible={tripFormVisible}
        trip={editingTrip}
        onClose={() => setTripFormVisible(false)}
      />
      <TripDetailSheet
        visible={Boolean(selectedTrip)}
        trip={selectedTrip}
        onClose={() => setSelectedTripId(null)}
        onEdit={openEdit}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  header: {
    minHeight: 88,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.card,
  },
  screenTitle: { color: colors.text, fontSize: 22, fontWeight: '800', lineHeight: 28 },
  tagline: { marginTop: 2, color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  headerAdd: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: colors.primaryBg },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, paddingBottom: 52 },
  routeIllustration: { width: 138, height: 42, flexDirection: 'row', alignItems: 'center' },
  routeLine: { flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.primary },
  routeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  routeDotStart: { marginRight: -1 },
  emptyTitle: { marginTop: 20, color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  emptyBody: { maxWidth: 320, marginTop: 10, color: colors.textSecondary, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  primaryButton: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 24, paddingHorizontal: 22, borderRadius: 15, backgroundColor: colors.primary },
  primaryLabel: { color: colors.textInverse, fontSize: 15, fontWeight: '800' },
  list: { padding: 20, paddingBottom: 40 },
  group: { marginBottom: 26 },
  groupTitle: { marginBottom: 10, color: colors.textSecondary, fontSize: 14, fontWeight: '800' },
  cards: { gap: 12 },
});
