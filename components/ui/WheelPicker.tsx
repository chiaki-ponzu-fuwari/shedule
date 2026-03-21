import React, { useRef, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors } from '../../constants/colors';

export const WHEEL_ITEM_H = 44;

interface Props {
  items: (string | number)[];
  selectedIndex: number;
  onChange: (index: number) => void;
  width?: number;
  formatItem?: (item: string | number) => string;
}

const isWeb = Platform.OS === 'web';

export function WheelPicker({ items, selectedIndex, onChange, width = 88, formatItem }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const [visualIndex, setVisualIndex] = useState(selectedIndex);

  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  const fromUserRef = useRef(false);

  // Web用: スクロール停止を検知するデバウンスタイマー
  const webScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 初期表示 or 外部変更時にスクロール位置を同期
  useEffect(() => {
    if (fromUserRef.current) {
      fromUserRef.current = false;
      return;
    }
    setVisualIndex(selectedIndex);
    const t = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: selectedIndex * WHEEL_ITEM_H, animated: false });
    }, 50);
    return () => clearTimeout(t);
  }, [selectedIndex]);

  // 選択確定
  const commit = (y: number) => {
    const idx = Math.round(y / WHEEL_ITEM_H);
    const clamped = Math.max(0, Math.min(idx, items.length - 1));
    setVisualIndex(clamped);
    if (clamped !== selectedIndexRef.current) {
      fromUserRef.current = true;
      if (!isWeb) Haptics.selectionAsync();
      onChange(clamped);
    }
  };

  // スクロール中のリアルタイム視覚更新 ＋ Web用スクロール終了検知
  const handleScroll = (e: any) => {
    const y = e.nativeEvent.contentOffset.y;
    const idx = Math.max(0, Math.min(Math.round(y / WHEEL_ITEM_H), items.length - 1));
    if (idx !== visualIndex) setVisualIndex(idx);

    if (isWeb) {
      // Webはmomentum/snapイベントがないのでデバウンスで終了検知
      if (webScrollTimer.current) clearTimeout(webScrollTimer.current);
      webScrollTimer.current = setTimeout(() => {
        const snappedY = idx * WHEEL_ITEM_H;
        // スナップ位置に吸着
        scrollRef.current?.scrollTo({ y: snappedY, animated: false });
        commit(snappedY);
      }, 120);
    }
  };

  // Native用: モーメンタム有無で確定ハンドラを振り分け
  const momentumStarted = useRef(false);

  return (
    <View style={[styles.container, { width }]}>
      <View style={styles.highlight} pointerEvents="none" />

      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        snapToInterval={isWeb ? undefined : WHEEL_ITEM_H}
        decelerationRate={isWeb ? undefined : 'fast'}
        onScroll={handleScroll}
        scrollEventThrottle={isWeb ? 16 : 32}
        onScrollBeginDrag={isWeb ? undefined : () => { momentumStarted.current = false; }}
        onMomentumScrollBegin={isWeb ? undefined : () => { momentumStarted.current = true; }}
        onMomentumScrollEnd={isWeb ? undefined : (e) => {
          momentumStarted.current = false;
          commit(e.nativeEvent.contentOffset.y);
        }}
        onScrollEndDrag={isWeb ? undefined : (e) => {
          setTimeout(() => {
            if (!momentumStarted.current) {
              commit(e.nativeEvent.contentOffset.y);
            }
          }, 80);
        }}
        contentContainerStyle={{ paddingVertical: WHEEL_ITEM_H }}
        nestedScrollEnabled
      >
        {items.map((item, i) => {
          const dist = Math.abs(i - visualIndex);
          return (
            <View key={i} style={styles.item}>
              <Text
                style={[
                  styles.itemBase,
                  dist === 0 && styles.itemSelected,
                  dist === 1 && styles.itemAdjacent,
                  dist > 1 && styles.itemFar,
                ]}
              >
                {formatItem ? formatItem(item) : String(item)}
              </Text>
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.fadeTop} pointerEvents="none" />
      <View style={styles.fadeBottom} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: WHEEL_ITEM_H * 3,
    overflow: 'hidden',
    position: 'relative',
  },
  highlight: {
    position: 'absolute',
    top: WHEEL_ITEM_H,
    left: 4,
    right: 4,
    height: WHEEL_ITEM_H,
    backgroundColor: '#EDE9FE',
    borderRadius: 12,
    zIndex: 0,
  },
  item: {
    height: WHEEL_ITEM_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemBase: {
    fontSize: 14,
    fontWeight: '400',
    color: '#D0C0E0',
    textAlign: 'center',
  },
  itemSelected: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.text,
  },
  itemAdjacent: {
    fontSize: 18,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  itemFar: {
    fontSize: 12,
    color: '#DDD0EE',
  },
  fadeTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: WHEEL_ITEM_H,
    backgroundColor: 'rgba(253,250,255,0.85)',
    zIndex: 1,
  },
  fadeBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: WHEEL_ITEM_H,
    backgroundColor: 'rgba(253,250,255,0.85)',
    zIndex: 1,
  },
});
