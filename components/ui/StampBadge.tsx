import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useStampStore } from '../../store/stampStore';

interface Props {
  stampId: string;
  size?: 'tiny' | 'small' | 'medium' | 'large';
  style?: object;
}

const SIZES = {
  tiny:   { width: 18, height: 18, fontSize: 8,  borderRadius: 5 },
  small:  { width: 32, height: 32, fontSize: 12, borderRadius: 8 },
  medium: { width: 48, height: 48, fontSize: 16, borderRadius: 12 },
  large:  { width: 72, height: 72, fontSize: 24, borderRadius: 18 },
};

export function StampBadge({ stampId, size = 'medium', style }: Props) {
  const getStamp = useStampStore((s) => s.getStamp);
  const stamp = getStamp(stampId);

  if (!stamp) return null;

  const s = SIZES[size];

  return (
    <View
      style={[
        styles.badge,
        {
          width: s.width,
          height: s.height,
          backgroundColor: stamp.bgColor,
          borderRadius: s.borderRadius,
        },
        style,
      ]}
    >
      <Text style={[styles.text, { color: stamp.textColor, fontSize: s.fontSize }]} numberOfLines={1}>
        {stamp.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  text: {
    fontWeight: '800',
    textAlign: 'center',
  },
});
