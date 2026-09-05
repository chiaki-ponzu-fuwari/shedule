import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import { TRIP_ITEM_TYPES } from '../../constants/travel';
import { useTripStore } from '../../store/tripStore';
import type { Trip, TripItem, TripItemDraft, TripItemType } from '../../types/travel';
import { normalizeSafeUrl } from '../../utils/safeUrl';
import { formatMonthDay } from '../../utils/dateUtils';
import { isValidLocalDate } from '../../utils/tripUtils';
import {
  deviceTimeZone,
  normalizeIanaTimeZone,
  type TripLocalTimeChoice,
  type TripLocalTimeDisambiguation,
  TripTimeZoneError,
  zonedDateTimeParts,
  zonedLocalDateTimeChoices,
  zonedLocalDateTimeToUtc,
} from '../../utils/tripTimezone';
import { TravelDateField } from './TravelDateField';
import { ITEM_ICON_NAMES, itemTypeLabelKey } from './travelPresentation';

interface Props {
  visible: boolean;
  trip: Trip;
  item?: TripItem;
  onClose(): void;
}

interface FormState {
  type: TripItemType;
  localDate: string;
  arrivalLocalDate: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  departureTimezone: string;
  arrivalTimezone: string;
  departureDisambiguation: '' | TripLocalTimeDisambiguation;
  arrivalDisambiguation: '' | TripLocalTimeDisambiguation;
  departure: string;
  arrival: string;
  place: string;
  reservationNumber: string;
  url: string;
  memo: string;
}

function safeZonedParts(utc: string | undefined, timezone: string) {
  if (!utc) return undefined;
  try {
    return zonedDateTimeParts(utc, timezone);
  } catch {
    return undefined;
  }
}

function safeRepeatedTimeChoices(date: string, time: string, timezone: string) {
  if (!time.trim()) return [];
  try {
    const choices = zonedLocalDateTimeChoices(date, time, timezone);
    return choices.length > 1 ? choices : [];
  } catch {
    return [];
  }
}

function disambiguationForStoredInstant(
  date: string,
  time: string,
  timezone: string,
  instant: string | undefined,
): '' | TripLocalTimeDisambiguation {
  if (!instant) return '';
  return safeRepeatedTimeChoices(date, time, timezone)
    .find((choice) => choice.instant === instant)?.disambiguation ?? '';
}

function initialForm(trip: Trip, item?: TripItem): FormState {
  const localTimezone = deviceTimeZone();
  const departureTimezone = normalizeIanaTimeZone(item?.departureTimezone ?? '') ?? localTimezone;
  const arrivalTimezone = normalizeIanaTimeZone(item?.arrivalTimezone ?? '') ?? departureTimezone;
  const departureParts = safeZonedParts(item?.startsAtUtc, departureTimezone);
  const arrivalParts = safeZonedParts(item?.endsAtUtc, arrivalTimezone);
  const localDate = item?.localDate ?? trip.startDate;
  const arrivalLocalDate = item?.arrivalLocalDate ?? arrivalParts?.date ?? localDate;
  const startTime = departureParts?.time ?? '';
  const endTime = arrivalParts?.time ?? '';
  return {
    type: item?.type ?? 'flight',
    localDate,
    arrivalLocalDate,
    allDay: item?.allDay ?? false,
    startTime,
    endTime,
    departureTimezone,
    arrivalTimezone,
    departureDisambiguation: disambiguationForStoredInstant(
      localDate,
      startTime,
      departureTimezone,
      item?.startsAtUtc,
    ),
    arrivalDisambiguation: disambiguationForStoredInstant(
      arrivalLocalDate,
      endTime,
      arrivalTimezone,
      item?.endsAtUtc,
    ),
    departure: item?.departure ?? '',
    arrival: item?.arrival ?? '',
    place: item?.place ?? '',
    reservationNumber: item?.reservationNumber ?? '',
    url: item?.url ?? '',
    memo: item?.memo ?? '',
  };
}

const formFingerprint = (form: FormState) => JSON.stringify(form);

function optional(value: string) {
  const normalized = value.trim();
  return normalized || undefined;
}

function utcFromFormTime(
  date: string,
  time: string,
  timezone: string,
  disambiguation: '' | TripLocalTimeDisambiguation,
): string | undefined {
  if (!time.trim()) return undefined;
  return zonedLocalDateTimeToUtc(date, time, timezone, disambiguation || undefined);
}

const isRouteType = (type: TripItemType) =>
  type === 'flight' || type === 'train' || type === 'transport';

export function TripItemFormSheet({ visible, trip, item, onClose }: Props) {
  const { t, locale } = useTranslation();
  const addItem = useTripStore((state) => state.addItem);
  const updateItem = useTripStore((state) => state.updateItem);
  const deleteItem = useTripStore((state) => state.deleteItem);
  const [form, setForm] = useState<FormState>(() => initialForm(trip, item));
  const [error, setError] = useState('');
  const [timingDetailsVisible, setTimingDetailsVisible] = useState(false);
  const original = useRef(formFingerprint(initialForm(trip, item)));

  useEffect(() => {
    if (!visible) return;
    const next = initialForm(trip, item);
    setForm(next);
    original.current = formFingerprint(next);
    setError('');
    setTimingDetailsVisible(false);
  }, [item, trip, visible]);

  const dirty = useMemo(() => formFingerprint(form) !== original.current, [form]);

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

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const setDepartureDate = (value: string) => {
    setForm((current) => ({
      ...current,
      localDate: value,
      arrivalLocalDate: current.arrivalLocalDate === current.localDate
        ? value
        : current.arrivalLocalDate,
    }));
  };

  const selectType = (type: TripItemType) => {
    setForm((current) => ({
      ...current,
      type,
      allDay: type === 'hotel' || type === 'memo' ? true : current.allDay,
    }));
    setError('');
  };

  const save = () => {
    const routeFields = isRouteType(form.type);
    if (
      !isValidLocalDate(form.localDate)
      || form.localDate < trip.startDate
      || form.localDate > trip.endDate
    ) {
      setError(t('travel.error.itemDate'));
      return;
    }
    if (routeFields && !form.allDay && (
      !isValidLocalDate(form.arrivalLocalDate)
      || form.arrivalLocalDate < trip.startDate
      || form.arrivalLocalDate > trip.endDate
    )) {
      setError(t('travel.error.arrivalDate'));
      return;
    }
    const safeUrl = normalizeSafeUrl(form.url);
    if (safeUrl === null) {
      setError(t('travel.error.url'));
      return;
    }

    try {
      const departureTimezone = form.allDay
        ? undefined
        : normalizeIanaTimeZone(form.departureTimezone) ?? undefined;
      const arrivalTimezone = form.allDay
        ? undefined
        : normalizeIanaTimeZone(form.arrivalTimezone) ?? undefined;
      if (!form.allDay && (!departureTimezone || !arrivalTimezone)) {
        setError(t('travel.error.timezone'));
        return;
      }
      const originalForm = item ? initialForm(trip, item) : undefined;
      const keepsOriginalStart = Boolean(
        item
        && form.localDate === item.localDate
        && form.startTime === originalForm?.startTime
        && departureTimezone === normalizeIanaTimeZone(originalForm?.departureTimezone ?? '')
        && form.departureDisambiguation === originalForm?.departureDisambiguation
      );
      const keepsOriginalEnd = Boolean(
        item
        && form.arrivalLocalDate === originalForm?.arrivalLocalDate
        && form.endTime === originalForm?.endTime
        && arrivalTimezone === normalizeIanaTimeZone(originalForm?.arrivalTimezone ?? '')
        && form.arrivalDisambiguation === originalForm?.arrivalDisambiguation
      );
      const startsAtUtc = form.allDay
        ? undefined
        : keepsOriginalStart
          ? item?.startsAtUtc
          : utcFromFormTime(
              form.localDate,
              form.startTime,
              departureTimezone!,
              form.departureDisambiguation,
            );
      const endDate = routeFields ? form.arrivalLocalDate : form.localDate;
      const endsAtUtc = form.allDay
        ? undefined
        : keepsOriginalEnd
          ? item?.endsAtUtc
          : utcFromFormTime(
              endDate,
              form.endTime,
              arrivalTimezone!,
              form.arrivalDisambiguation,
            );
      if (
        startsAtUtc
        && endsAtUtc
        && Date.parse(endsAtUtc) < Date.parse(startsAtUtc)
      ) {
        setError(t('travel.error.timeOrder'));
        return;
      }
      const draft: TripItemDraft = {
        type: form.type,
        localDate: form.localDate,
        arrivalLocalDate: form.allDay || !routeFields ? undefined : form.arrivalLocalDate,
        allDay: form.allDay,
        startsAtUtc,
        endsAtUtc,
        departureTimezone: form.allDay ? undefined : departureTimezone,
        arrivalTimezone: form.allDay ? undefined : arrivalTimezone,
        departure: optional(form.departure),
        arrival: optional(form.arrival),
        place: optional(form.place),
        reservationNumber: optional(form.reservationNumber),
        url: safeUrl,
        memo: optional(form.memo),
        sortOrder: item?.sortOrder ?? useTripStore.getState().items.filter((candidate) => candidate.tripId === trip.id).length * 10,
        notificationId: item?.notificationId,
      };
      if (item) updateItem(item.id, draft);
      else addItem(trip.id, draft);
      onClose();
    } catch (saveError) {
      if (saveError instanceof TripTimeZoneError) {
        if (saveError.code === 'invalid-time') setError(t('travel.error.time'));
        else if (saveError.code === 'invalid-timezone') setError(t('travel.error.timezone'));
        else if (saveError.code === 'nonexistent-local-time') {
          setError(t('travel.error.nonexistentTime'));
        } else if (saveError.code === 'ambiguous-local-time') {
          setError(t('travel.error.ambiguousTime'));
        } else setError(t('travel.error.save'));
        return;
      }
      setError(t('travel.error.save'));
    }
  };

  const confirmDelete = () => {
    if (!item) return;
    Alert.alert(t('travel.deleteItemTitle'), t('travel.deleteItemBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          deleteItem(item.id);
          onClose();
        },
      },
    ]);
  };

  const routeFields = isRouteType(form.type);
  const placeField = form.type === 'hotel' || form.type === 'event' || form.type === 'meal';
  const reservationField = form.type === 'flight' || form.type === 'train'
    || form.type === 'hotel' || form.type === 'transport';
  const endDate = routeFields ? form.arrivalLocalDate : form.localDate;
  const departureTimeChoices = useMemo(
    () => safeRepeatedTimeChoices(form.localDate, form.startTime, form.departureTimezone),
    [form.departureTimezone, form.localDate, form.startTime],
  );
  const arrivalTimeChoices = useMemo(
    () => safeRepeatedTimeChoices(endDate, form.endTime, form.arrivalTimezone),
    [endDate, form.arrivalTimezone, form.endTime],
  );

  return (
    <Modal transparent animationType="slide" visible={visible} statusBarTranslucent onRequestClose={requestClose}>
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
              accessibilityLabel={`${item ? t('travel.editItem') : t('travel.addItinerary')}${t('travel.dialogSuffix')}`}
              style={styles.title}
            >
              {item ? t('travel.editItem') : t('travel.addItinerary')}
            </Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('common.close')} onPress={requestClose} style={styles.closeButton}>
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.form}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.typeRow}>
              {TRIP_ITEM_TYPES.map((type) => (
                <TouchableOpacity
                  key={type}
                  accessibilityRole="button"
                  accessibilityLabel={t(itemTypeLabelKey(type))}
                  accessibilityState={{ selected: form.type === type }}
                  onPress={() => selectType(type)}
                  style={[styles.typeButton, form.type === type && styles.typeButtonSelected]}
                >
                  <Ionicons name={ITEM_ICON_NAMES[type]} size={17} color={form.type === type ? colors.primary : colors.textSecondary} />
                  <Text style={[styles.typeLabel, form.type === type && styles.typeLabelSelected]}>{t(itemTypeLabelKey(type))}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <TravelDateField
              label={t(routeFields ? 'travel.departureDate' : 'travel.itemDate')}
              value={form.localDate}
              minimumDate={trip.startDate}
              maximumDate={trip.endDate}
              onChange={setDepartureDate}
            />

            {form.type !== 'memo' ? (
              <View style={styles.switchRow}>
                <View style={styles.switchCopy}>
                  <Text style={styles.label}>{t('travel.allDay')}</Text>
                  <Text style={styles.hint}>{t('travel.allDayHint')}</Text>
                </View>
                <Switch
                  accessibilityLabel={t('travel.allDay')}
                  value={form.allDay}
                  onValueChange={(value) => setField('allDay', value)}
                  trackColor={{ false: '#CBD5E1', true: colors.primaryLight }}
                  thumbColor={form.allDay ? colors.primary : '#FFFFFF'}
                />
              </View>
            ) : null}

            {!form.allDay && form.type !== 'memo' ? (
              <View style={styles.timingSection}>
                <View style={styles.inlineFields}>
                  <LabeledInput label={t(routeFields ? 'travel.departureTime' : 'travel.startTime')} value={form.startTime} onChangeText={(value) => setField('startTime', value)} placeholder="09:00" />
                  <LabeledInput label={t(routeFields ? 'travel.arrivalTime' : 'travel.endTime')} value={form.endTime} onChangeText={(value) => setField('endTime', value)} placeholder="11:30" />
                </View>
                {departureTimeChoices.length > 1 ? (
                  <RepeatedTimeChoice
                    label={t(routeFields ? 'travel.departureTime' : 'travel.startTime')}
                    choices={departureTimeChoices}
                    value={form.departureDisambiguation}
                    onChange={(value) => {
                      setField('departureDisambiguation', value);
                      setError('');
                    }}
                  />
                ) : null}
                {arrivalTimeChoices.length > 1 ? (
                  <RepeatedTimeChoice
                    label={t(routeFields ? 'travel.arrivalTime' : 'travel.endTime')}
                    choices={arrivalTimeChoices}
                    value={form.arrivalDisambiguation}
                    onChange={(value) => {
                      setField('arrivalDisambiguation', value);
                      setError('');
                    }}
                  />
                ) : null}
              </View>
            ) : null}

            {routeFields && !form.allDay ? (
              <View style={styles.timingSection}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={t('travel.timingDetails')}
                  accessibilityState={{ expanded: timingDetailsVisible }}
                  onPress={() => setTimingDetailsVisible((current) => !current)}
                  style={styles.timingButton}
                >
                  <View style={styles.timingCopy}>
                    <Text style={styles.timingTitle}>{t('travel.timingDetails')}</Text>
                    <Text style={styles.timingSummary} numberOfLines={2}>
                      {form.arrivalLocalDate === form.localDate
                        ? t('travel.sameDay')
                        : isValidLocalDate(form.arrivalLocalDate)
                          ? formatMonthDay(form.arrivalLocalDate, locale)
                          : form.arrivalLocalDate}
                      {' · '}{form.departureTimezone} → {form.arrivalTimezone}
                    </Text>
                  </View>
                  <Ionicons
                    name={timingDetailsVisible ? 'chevron-up' : 'chevron-down'}
                    size={18}
                    color={colors.primary}
                  />
                </TouchableOpacity>
                {timingDetailsVisible ? (
                  <View style={styles.timingPanel}>
                    <TravelDateField
                      label={t('travel.arrivalDate')}
                      value={form.arrivalLocalDate}
                      minimumDate={trip.startDate}
                      maximumDate={trip.endDate}
                      onChange={(value) => setField('arrivalLocalDate', value)}
                    />
                    <View style={styles.timezoneFields}>
                      <LabeledInput
                        label={t('travel.departureTimezone')}
                        value={form.departureTimezone}
                        onChangeText={(value) => setField('departureTimezone', value)}
                        placeholder="Asia/Tokyo"
                        autoCapitalize="none"
                      />
                      <LabeledInput
                        label={t('travel.arrivalTimezone')}
                        value={form.arrivalTimezone}
                        onChangeText={(value) => setField('arrivalTimezone', value)}
                        placeholder="Asia/Tokyo"
                        autoCapitalize="none"
                      />
                    </View>
                    <Text style={styles.timezoneHint}>{t('travel.timezoneHint')}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {routeFields ? (
              <View style={styles.inlineFields}>
                <LabeledInput label={t('travel.departure')} value={form.departure} onChangeText={(value) => setField('departure', value)} />
                <LabeledInput label={t('travel.arrival')} value={form.arrival} onChangeText={(value) => setField('arrival', value)} />
              </View>
            ) : null}

            {placeField ? (
              <LabeledInput label={t('travel.place')} value={form.place} onChangeText={(value) => setField('place', value)} />
            ) : null}

            {reservationField ? (
              <LabeledInput label={t('travel.reservation')} value={form.reservationNumber} onChangeText={(value) => setField('reservationNumber', value)} />
            ) : null}

            <LabeledInput
              label="URL"
              value={form.url}
              onChangeText={(value) => setField('url', value)}
              placeholder="https://"
              autoCapitalize="none"
              keyboardType="url"
            />
            <LabeledInput
              label={t('travel.memo')}
              value={form.memo}
              onChangeText={(value) => setField('memo', value)}
              placeholder={t('travel.itemMemoPlaceholder')}
              multiline
            />

            {error ? <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text> : null}

            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('travel.saveItinerary')} onPress={save} style={styles.saveButton}>
              <Text style={styles.saveLabel}>{t('travel.save')}</Text>
            </TouchableOpacity>
            {item ? (
              <TouchableOpacity accessibilityRole="button" onPress={confirmDelete} style={styles.deleteButton}>
                <Text style={styles.deleteLabel}>{t('travel.deleteItem')}</Text>
              </TouchableOpacity>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function RepeatedTimeChoice({
  label,
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: readonly TripLocalTimeChoice[];
  value: '' | TripLocalTimeDisambiguation;
  onChange(value: TripLocalTimeDisambiguation): void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.foldChoice}>
      <Text style={styles.foldHint}>{t('travel.ambiguousTimeHint', { time: label })}</Text>
      <View style={styles.foldButtons}>
        {choices.map((choice, index) => {
          const accessibilityLabel = t(
            index === 0 ? 'travel.fold.earlier' : 'travel.fold.later',
            { offset: choice.offsetLabel },
          );
          const selected = value === choice.disambiguation;
          return (
            <TouchableOpacity
              key={choice.instant}
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              accessibilityState={{ selected }}
              onPress={() => onChange(choice.disambiguation)}
              style={[styles.foldButton, selected && styles.foldButtonSelected]}
            >
              <Text style={[styles.foldButtonText, selected && styles.foldButtonTextSelected]}>
                {accessibilityLabel}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function LabeledInput({
  label,
  multiline,
  ...props
}: {
  label: string;
  multiline?: boolean;
  value: string;
  onChangeText(value: string): void;
  placeholder?: string;
  autoCapitalize?: 'none';
  keyboardType?: 'url';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        multiline={multiline}
        placeholderTextColor={colors.textLight}
        style={[styles.input, multiline && styles.multiline]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.45)' },
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
  form: { gap: 16, paddingBottom: 10 },
  typeRow: { gap: 8, paddingRight: 4 },
  typeButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.surfaceGray,
  },
  typeButtonSelected: { borderColor: colors.primary, backgroundColor: colors.primaryBg },
  typeLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  typeLabelSelected: { color: colors.primary },
  field: { flex: 1, gap: 7 },
  label: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  hint: { marginTop: 2, color: colors.textLight, fontSize: 11 },
  input: {
    minHeight: 46,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 12,
    color: colors.text,
    backgroundColor: colors.card,
    fontSize: 14,
  },
  multiline: { minHeight: 82, textAlignVertical: 'top' },
  inlineFields: { flexDirection: 'row', gap: 10 },
  switchRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  switchCopy: { flex: 1, paddingRight: 12 },
  timingSection: { gap: 10 },
  timingButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.surfaceGray,
  },
  timingCopy: { flex: 1 },
  timingTitle: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  timingSummary: { marginTop: 3, color: colors.textSecondary, fontSize: 11, lineHeight: 16 },
  timingPanel: { gap: 12, paddingHorizontal: 2 },
  timezoneFields: { gap: 12 },
  timezoneHint: { color: colors.textLight, fontSize: 11, lineHeight: 16 },
  foldChoice: { gap: 7, padding: 10, borderRadius: 10, backgroundColor: '#FFF7E6' },
  foldHint: { color: '#92400E', fontSize: 11, lineHeight: 16, fontWeight: '600' },
  foldButtons: { flexDirection: 'row', gap: 8 },
  foldButton: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#F59E0B',
    backgroundColor: '#FFFFFF',
  },
  foldButtonSelected: { borderColor: colors.primary, backgroundColor: '#EAF2FF' },
  foldButtonText: { color: '#92400E', fontSize: 11, fontWeight: '700' },
  foldButtonTextSelected: { color: colors.primary },
  error: { color: '#B91C1C', fontSize: 13, fontWeight: '700', lineHeight: 19 },
  saveButton: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: colors.primary },
  saveLabel: { color: colors.textInverse, fontSize: 16, fontWeight: '800' },
  deleteButton: { minHeight: 46, alignItems: 'center', justifyContent: 'center' },
  deleteLabel: { color: '#B91C1C', fontSize: 14, fontWeight: '700' },
});
