import React from 'react';
import { Text, StyleProp, TextStyle } from 'react-native';

/** U+2236（比の記号）— 見た目はコロンに近く、時刻の自動置換を起こしにくい */
const TIME_SEP = '\u2236';

/**
 * タイムライン左の時刻ラベル（HH∶00）。
 * 1つの Text にまとめて字間のばらつきを防ぎ、親スタイルの等幅フォントで揃える。
 */
export function TimelineHourLabel({ hour, style }: { hour: number; style?: StyleProp<TextStyle> }) {
  const h = Math.floor(hour);
  if (h === 24) {
    return (
      <Text style={style} allowFontScaling={false}>
        {`24${TIME_SEP}00`}
      </Text>
    );
  }
  const clamped = Math.max(0, Math.min(23, h));
  const hh = String(clamped).padStart(2, '0');
  return (
    <Text style={style} allowFontScaling={false}>
      {`${hh}${TIME_SEP}00`}
    </Text>
  );
}
