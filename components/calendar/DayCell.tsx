import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { DayInfo, DayEntry, Stamp } from '../../types';
import { colors } from '../../constants/colors';

/** 左右それぞれのマージン（MonthlyView の列幅計算と揃える） */
export const DAY_CELL_MARGIN_H = 2;
const CELL_H_SHRINK = 12;
const CELL_H = 74 - CELL_H_SHRINK;

interface Props {
  day: DayInfo;
  entry?: DayEntry;
  mainStamp?: Stamp;
  leftMiniStamp?: Stamp;
  rightMiniStamp?: Stamp;
  onPress: () => void;
  isSelected: boolean;
  imageUri?: string;
  hasNotes?: boolean;
  /** 親グリッドの実幅に基づくセル幅（Web 等で window 幅とコンテナ幅がずれる場合に必須） */
  cellWidth?: number;
}

export function DayCell({
  day,
  entry,
  mainStamp,
  leftMiniStamp,
  rightMiniStamp,
  onPress,
  isSelected,
  imageUri,
  hasNotes,
  cellWidth,
}: Props) {
  const isOtherMonth = !day.isCurrentMonth;

  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.cell,
        cellWidth != null
          ? { width: cellWidth }
          : { flexGrow: 0, flexShrink: 0, flexBasis: '14.285714%', maxWidth: '14.285714%' },
        isSelected && styles.cellSelected,
        isOtherMonth && styles.cellFaded,
      ]}
      activeOpacity={0.65}
    >
      {/* ── 日付（左上固定）── */}
      <View style={styles.dateAnchor}>
        <Text
          style={[
            styles.dateNum,
            day.isToday && styles.todayNum,
            !day.isToday && day.isSunday && styles.sundayNum,
            !day.isToday && day.isSaturday && styles.saturdayNum,
            isOtherMonth && styles.otherNum,
          ]}
        >
          {day.date.getDate()}
        </Text>
        <View style={styles.dotsRow}>
          {day.specialDate && <View style={[styles.dot, { backgroundColor: '#60A5FA' }]} />}
          {hasNotes && <View style={[styles.dot, { backgroundColor: '#FFB3CC' }]} />}
        </View>
      </View>

      {/* ── 画像スタンプ（右上固定）── */}
      {imageUri ? (
        imageUri.startsWith('icon://') ? (
          <View style={styles.imageStamp}>
            <Ionicons
              name={imageUri.replace('icon://', '') as any}
              size={14}
              color={colors.primary}
            />
          </View>
        ) : (
          <Image source={{ uri: imageUri }} style={styles.imageStamp} />
        )
      ) : null}

      {/* ── ミニ＋メイン帯（隙間なし・下端ぴったり）── */}
      <View style={styles.bottomBlock}>
        {/* ミニスタンプ行 */}
        <View style={styles.miniRow}>
          {leftMiniStamp ? (
            <View style={[styles.miniBar, { backgroundColor: leftMiniStamp.bgColor }]}>
              <Text style={[styles.miniText, { color: leftMiniStamp.textColor }]} numberOfLines={1}>
                {leftMiniStamp.text}
              </Text>
            </View>
          ) : (
            <View style={styles.miniBarEmpty} />
          )}
          {rightMiniStamp ? (
            <View style={[styles.miniBar, { backgroundColor: rightMiniStamp.bgColor }]}>
              <Text style={[styles.miniText, { color: rightMiniStamp.textColor }]} numberOfLines={1}>
                {rightMiniStamp.text}
              </Text>
            </View>
          ) : (
            <View style={styles.miniBarEmpty} />
          )}
        </View>

        {/* メインスタンプ帯（下枠まで塗り潰し）*/}
        {mainStamp ? (
          <View style={[styles.mainBand, { backgroundColor: mainStamp.bgColor }]}>
            <Text style={[styles.mainBandText, { color: mainStamp.textColor }]} numberOfLines={1}>
              {mainStamp.text}
            </Text>
          </View>
        ) : (
          <View style={styles.mainBandEmpty} />
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  cell: {
    height: CELL_H,
    marginHorizontal: DAY_CELL_MARGIN_H,
    marginVertical: 1,
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
    paddingTop: 0,
    paddingBottom: 0,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
  },
  cellSelected: {
    backgroundColor: '#FFF0F8',
  },
  cellFaded: {
    opacity: 0.28,
  },

  dotsRow: { flexDirection: 'row', gap: 2, marginTop: 1 },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },

  // 左上：日付固定（角に寄せて“中身領域”を広く見せる）
  dateAnchor: {
    position: 'absolute',
    top: 2,
    left: 2,
    alignItems: 'flex-start',
  },
  imageStamp: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 20,
    height: 20,
    borderRadius: 10,
  },

  dateNum: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text,
    lineHeight: 14,
  },
  todayNum: { color: colors.text, fontWeight: '900' },
  sundayNum: { color: colors.sunday },
  saturdayNum: { color: colors.saturday },
  otherNum: { color: '#C9B8D8' },

  // ミニ＋メイン帯をまとめたブロック（隙間なし）
  bottomBlock: {
    width: '100%',
    flexDirection: 'column',
    gap: 0,
  },

  // ミニスタンプ
  miniRow: {
    flexDirection: 'row',
    width: '100%',
    height: 15,
  },
  miniBar: {
    flex: 1,
    height: 15,
    borderRadius: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    opacity: 0.55,
  },
  miniBarEmpty: {
    flex: 1,
    height: 15,
  },
  miniText: {
    fontSize: 10,
    fontWeight: '400',
    textAlign: 'center',
    letterSpacing: -0.5,
  },

  // メインスタンプ帯（全幅・下端ぴったり）
  mainBand: {
    width: '100%',
    height: 22,
    borderRadius: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  mainBandText: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  mainBandEmpty: {
    width: '100%',
    height: 22,
  },
});
