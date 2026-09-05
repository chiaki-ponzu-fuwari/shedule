import React, { useRef, useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Haptics } from '../../utils/haptics';
import { CalendarView } from '../../types';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';

const TAB_KEYS: { key: CalendarView; labelKey: string }[] = [
  { key: 'monthly', labelKey: 'view.month' },
  { key: 'weekly', labelKey: 'view.week' },
  { key: 'daily', labelKey: 'view.day' },
];

interface Props {
  value: CalendarView;
  onChange: (v: CalendarView) => void;
}

export function ViewToggle({ value, onChange }: Props) {
  const { t } = useTranslation();
  const tabs = useMemo(
    () => TAB_KEYS.map((row) => ({ ...row, label: t(row.labelKey) })),
    [t]
  );
  const activeIndex = tabs.findIndex((tab) => tab.key === value);
  const slideAnim = useRef(new Animated.Value(activeIndex)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: activeIndex,
      useNativeDriver: true,
      tension: 180,
      friction: 20,
    }).start();
  }, [activeIndex]);

  const PILL_WIDTH = 60;

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.pill,
          {
            transform: [
              {
                translateX: slideAnim.interpolate({
                  inputRange: [0, 1, 2],
                  outputRange: [2, PILL_WIDTH + 2, PILL_WIDTH * 2 + 2],
                }),
              },
            ],
          },
        ]}
      />
      {tabs.map((tab) => (
        <TouchableOpacity
          key={tab.key}
          style={styles.tab}
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            onChange(tab.key);
          }}
        >
          <Text
            style={[
              styles.tabText,
              value === tab.key && styles.tabTextActive,
            ]}
          >
            {tab.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: '#F0E6F0',
    borderRadius: 14,
    padding: 2,
    position: 'relative',
    height: 36,
    width: 186,
  },
  pill: {
    position: 'absolute',
    top: 2,
    width: 60,
    height: 32,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    shadowColor: '#3B82F6',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  tab: {
    width: 60,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textLight,
  },
  tabTextActive: {
    color: colors.primary,
    fontWeight: '700',
  },
});
