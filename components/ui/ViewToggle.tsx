import React, { useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import * as Haptics from 'expo-haptics';
import { CalendarView } from '../../types';
import { colors } from '../../constants/colors';

const TABS: { key: CalendarView; label: string }[] = [
  { key: 'monthly', label: '月' },
  { key: 'weekly',  label: '週' },
  { key: 'daily',   label: '日' },
];

interface Props {
  value: CalendarView;
  onChange: (v: CalendarView) => void;
}

export function ViewToggle({ value, onChange }: Props) {
  const activeIndex = TABS.findIndex((t) => t.key === value);
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
      {TABS.map((tab) => (
        <TouchableOpacity
          key={tab.key}
          style={styles.tab}
          onPress={() => {
            Haptics.selectionAsync();
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
    shadowColor: '#A78BFA',
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
