import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import { formatDate, formatFullDate, parseDate } from '../../utils/dateUtils';

interface Props {
  label: string;
  value: string;
  onChange(value: string): void;
  minimumDate?: string;
  maximumDate?: string;
}

export function TravelDateField({ label, value, onChange, minimumDate, maximumDate }: Props) {
  const { locale, t } = useTranslation();
  const [showPicker, setShowPicker] = useState(false);

  if (Platform.OS === 'web') {
    return (
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.inputWrap}>
          <Ionicons name="calendar-outline" size={16} color={colors.primary} />
          <TextInput
            accessibilityLabel={label}
            accessibilityHint={t('travel.dateFormatHint')}
            value={value}
            onChangeText={onChange}
            inputMode="numeric"
            maxLength={10}
            style={styles.webInput}
          />
        </View>
      </View>
    );
  }

  const handleChange = (event: DateTimePickerEvent, selected?: Date) => {
    if (Platform.OS === 'android') setShowPicker(false);
    if (event.type === 'set' && selected) onChange(formatDate(selected));
  };

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${formatFullDate(value, locale)}`}
        onPress={() => setShowPicker(true)}
        style={styles.button}
      >
        <Ionicons name="calendar-outline" size={16} color={colors.primary} />
        <Text style={styles.value} numberOfLines={1}>{formatFullDate(value, locale)}</Text>
      </TouchableOpacity>
      {showPicker ? (
        <DateTimePicker
          value={parseDate(value)}
          mode="date"
          display={Platform.OS === 'ios' ? 'compact' : 'default'}
          minimumDate={minimumDate ? parseDate(minimumDate) : undefined}
          maximumDate={maximumDate ? parseDate(maximumDate) : undefined}
          onChange={handleChange}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { flex: 1, gap: 7 },
  label: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  button: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 11,
    backgroundColor: colors.card,
  },
  value: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '600' },
  inputWrap: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 11,
    backgroundColor: colors.card,
  },
  webInput: { flex: 1, color: colors.text, fontSize: 14, paddingVertical: 10 },
});
