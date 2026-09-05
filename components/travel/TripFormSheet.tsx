import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import { TRIP_COLOR_PRESETS, TRIP_TRANSPORT_ICONS } from '../../constants/travel';
import { useTripStore } from '../../store/tripStore';
import type { Trip, TripDraft, TripTransportIcon } from '../../types/travel';
import { addDays, formatDate } from '../../utils/dateUtils';
import { validateTripDraft } from '../../utils/tripUtils';
import { TravelDateField } from './TravelDateField';
import { TRANSPORT_ICON_NAMES, transportLabelKey } from './travelPresentation';

interface Props {
  visible: boolean;
  trip?: Trip;
  onClose(): void;
  onSaved?(trip: Trip): void;
}

function initialDraft(trip?: Trip): TripDraft {
  const today = new Date();
  return trip
    ? {
        title: trip.title,
        startDate: trip.startDate,
        endDate: trip.endDate,
        color: trip.color,
        startIcon: trip.startIcon,
        endIcon: trip.endIcon,
        memo: trip.memo,
      }
    : {
        title: '',
        startDate: formatDate(today),
        endDate: formatDate(addDays(today, 2)),
        color: TRIP_COLOR_PRESETS[0],
        startIcon: 'none',
        endIcon: 'none',
        memo: '',
      };
}

function draftFingerprint(draft: TripDraft) {
  return JSON.stringify(draft);
}

export function TripFormSheet({ visible, trip, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const addTrip = useTripStore((state) => state.addTrip);
  const updateTrip = useTripStore((state) => state.updateTrip);
  const [draft, setDraft] = useState<TripDraft>(() => initialDraft(trip));
  const [error, setError] = useState('');
  const original = useRef(draftFingerprint(initialDraft(trip)));

  useEffect(() => {
    if (!visible) return;
    const next = initialDraft(trip);
    setDraft(next);
    original.current = draftFingerprint(next);
    setError('');
  }, [trip, visible]);

  const title = trip ? t('travel.editTrip') : t('travel.addTrip');
  const dirty = useMemo(() => draftFingerprint(draft) !== original.current, [draft]);

  const requestClose = () => {
    if (!dirty) {
      onClose();
      return;
    }
    Alert.alert(t('travel.discardTitle'), t('travel.discardBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('travel.discard'), style: 'destructive', onPress: onClose },
    ]);
  };

  const save = () => {
    const validation = validateTripDraft(draft);
    if (!validation.valid) {
      if (validation.errors.title) setError(t('travel.error.title'));
      else if (validation.errors.endDate === 'before-start') setError(t('travel.error.dateOrder'));
      else setError(t('travel.error.date'));
      return;
    }
    try {
      let saved: Trip;
      if (trip) {
        updateTrip(trip.id, draft);
        saved = useTripStore.getState().trips.find((item) => item.id === trip.id)!;
      } else {
        saved = addTrip(draft);
      }
      onSaved?.(saved);
      onClose();
    } catch {
      setError(t('travel.error.save'));
    }
  };

  const renderTransportRow = (
    side: 'start' | 'end',
    selected: TripTransportIcon,
  ) => (
    <View style={styles.transportRow}>
      {TRIP_TRANSPORT_ICONS.map((icon) => {
        const transport = t(transportLabelKey(icon));
        const label = side === 'start'
          ? t('travel.endpoint.start', { transport })
          : t('travel.endpoint.end', { transport });
        return (
          <TouchableOpacity
            key={icon}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: selected === icon }}
            onPress={() => setDraft((current) => ({
              ...current,
              [side === 'start' ? 'startIcon' : 'endIcon']: icon,
            }))}
            style={[styles.transportButton, selected === icon && styles.transportButtonSelected]}
          >
            <Ionicons
              name={TRANSPORT_ICON_NAMES[icon]}
              size={18}
              color={selected === icon ? colors.primary : colors.textSecondary}
            />
          </TouchableOpacity>
        );
      })}
    </View>
  );

  return (
    <Modal
      animationType="slide"
      transparent
      visible={visible}
      statusBarTranslucent
      onRequestClose={requestClose}
    >
      <View style={styles.overlay}>
        <View
          accessibilityViewIsModal
          style={styles.sheet}
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text
              accessible
              accessibilityRole="header"
              accessibilityLabel={`${title}${t('travel.dialogSuffix')}`}
              style={styles.title}
            >
              {title}
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              onPress={requestClose}
              style={styles.closeButton}
            >
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.form}
          >
            <View style={styles.field}>
              <Text style={styles.label}>{t('travel.name')}</Text>
              <TextInput
                accessibilityLabel={t('travel.name')}
                value={draft.title}
                onChangeText={(titleValue) => setDraft((current) => ({ ...current, title: titleValue }))}
                placeholder={t('travel.namePlaceholder')}
                placeholderTextColor={colors.textLight}
                maxLength={80}
                style={styles.input}
              />
            </View>

            <View style={styles.dateRow}>
              <TravelDateField
                label={t('travel.startDate')}
                value={draft.startDate}
                maximumDate={draft.endDate}
                onChange={(startDate) => setDraft((current) => ({ ...current, startDate }))}
              />
              <TravelDateField
                label={t('travel.endDate')}
                value={draft.endDate}
                minimumDate={draft.startDate}
                onChange={(endDate) => setDraft((current) => ({ ...current, endDate }))}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>{t('travel.color')}</Text>
              <View style={styles.colorRow}>
                {TRIP_COLOR_PRESETS.map((color, index) => (
                  <TouchableOpacity
                    key={color}
                    accessibilityRole="button"
                    accessibilityLabel={t('travel.colorChoice', { number: index + 1 })}
                    accessibilityState={{ selected: draft.color === color }}
                    onPress={() => setDraft((current) => ({ ...current, color }))}
                    style={styles.colorTarget}
                  >
                    <View style={[
                      styles.colorDot,
                      { backgroundColor: color },
                      draft.color === color && styles.colorDotSelected,
                    ]} />
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>{t('travel.startTransport')}</Text>
              {renderTransportRow('start', draft.startIcon)}
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>{t('travel.endTransport')}</Text>
              {renderTransportRow('end', draft.endIcon)}
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>{t('travel.memoOptional')}</Text>
              <TextInput
                accessibilityLabel={t('travel.memo')}
                value={draft.memo ?? ''}
                onChangeText={(memo) => setDraft((current) => ({ ...current, memo }))}
                placeholder={t('travel.tripMemoPlaceholder')}
                placeholderTextColor={colors.textLight}
                multiline
                maxLength={1000}
                style={[styles.input, styles.multiline]}
              />
            </View>

            {error ? (
              <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text>
            ) : null}

            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('travel.saveTrip')}
              onPress={save}
              style={styles.saveButton}
            >
              <Text style={styles.saveLabel}>{t('travel.save')}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.42)' },
  sheet: {
    maxHeight: '94%',
    paddingHorizontal: 20,
    paddingBottom: 34,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    backgroundColor: colors.card,
  },
  handle: { width: 38, height: 4, alignSelf: 'center', marginTop: 10, borderRadius: 2, backgroundColor: colors.primaryLight },
  header: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 19, fontWeight: '800' },
  closeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  form: { gap: 18, paddingBottom: 10 },
  field: { gap: 8 },
  label: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  input: {
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 12,
    color: colors.text,
    backgroundColor: colors.card,
    fontSize: 15,
  },
  multiline: { minHeight: 86, textAlignVertical: 'top' },
  dateRow: { flexDirection: 'row', gap: 10 },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  colorTarget: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  colorDot: { width: 30, height: 30, borderRadius: 15 },
  colorDotSelected: { borderWidth: 3, borderColor: colors.textInverse, transform: [{ scale: 1.12 }] },
  transportRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  transportButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.surfaceGray,
  },
  transportButtonSelected: { borderColor: colors.primary, backgroundColor: colors.primaryBg },
  error: { color: '#B91C1C', fontSize: 13, fontWeight: '700', lineHeight: 19 },
  saveButton: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: colors.primary,
  },
  saveLabel: { color: colors.textInverse, fontSize: 16, fontWeight: '800' },
});
