import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { DayInfo, DayEntry, Stamp } from '../../types';
import { colors } from '../../constants/colors';

const CELL_MARGIN = 2;  // 左右それぞれのマージン
const CELL_W = Math.floor((Dimensions.get('window').width - CELL_MARGIN * 2 * 7) / 7);
const CELL_H = 74;

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
}: Props) {
  const isOtherMonth = !day.isCurrentMonth;

  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.cell,
        isSelected && styles.cellSelected,
        isOtherMonth && styles.cellFaded,
      ]}
      activeOpacity={0.65}
    >
      {/* ── 日付（最上段）── */}
      <View style={styles.dateRow}>
        <View>
        <View style={[styles.dateCircle, day.isToday && styles.todayCircle]}>
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
          {day.specialDate && !day.isToday && (
            <View style={[styles.specialDot, { backgroundColor: '#60A5FA' }]} />
          )}
        </View>
        {hasNotes && <View style={styles.notesDot} />}
        </View>
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
      </View>

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
    width: CELL_W,
    height: CELL_H,
    marginHorizontal: CELL_MARGIN,
    marginVertical: 1,
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingTop: 4,
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

  notesDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#FFB3CC',
    alignSelf: 'flex-start',
    marginLeft: 3,
    marginTop: -2,
  },

  // 日付行（画像スタンプと並べる）
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingRight: 3,
  },
  imageStamp: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },

  // 日付
  dateCircle: {
    width: 24,
    height: 24,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 3,
  },
  todayCircle: {
    backgroundColor: '#D9D9D9',
    borderRadius: 12,
  },
  dateNum: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text,
    lineHeight: 14,
  },
  todayNum: { color: colors.text, fontWeight: '800' },
  sundayNum: { color: colors.sunday },
  saturdayNum: { color: colors.saturday },
  otherNum: { color: '#C9B8D8' },
  specialDot: {
    position: 'absolute',
    bottom: 1,
    right: 1,
    width: 5,
    height: 5,
    borderRadius: 3,
  },

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
    borderRadius: 0,           // 角丸なし→下枠にぴったり
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  mainBandText: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  mainBandEmpty: {
    width: '100%',
    height: 22,
  },
});
