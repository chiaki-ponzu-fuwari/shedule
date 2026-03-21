import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, SafeAreaView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useGroupStore } from '../../store/groupStore';
import { colors } from '../../constants/colors';

export default function JoinGroupScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const joinGroupByCode = useGroupStore((s) => s.joinGroupByCode);

  const [status, setStatus] = useState<'idle' | 'joining' | 'success' | 'error'>('idle');
  const [groupName, setGroupName] = useState('');

  const handleJoin = async () => {
    if (!code) return;
    setStatus('joining');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const group = await joinGroupByCode(code);
    if (group) {
      setGroupName(group.name);
      setStatus('success');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setStatus('error');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const goHome = () => {
    router.replace('/(tabs)/groups');
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.card}>
        {status === 'idle' && (
          <>
            <Text style={styles.emoji}>👥</Text>
            <Text style={styles.title}>グループに参加</Text>
            <Text style={styles.desc}>招待コード</Text>
            <Text style={styles.code}>{code}</Text>
            <TouchableOpacity style={styles.btn} onPress={handleJoin}>
              <Text style={styles.btnText}>参加する</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={goHome}>
              <Text style={styles.cancelBtnText}>キャンセル</Text>
            </TouchableOpacity>
          </>
        )}

        {status === 'joining' && (
          <>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.desc}>参加中...</Text>
          </>
        )}

        {status === 'success' && (
          <>
            <Ionicons name="checkmark-circle" size={64} color="#34D399" />
            <Text style={styles.title}>参加しました！</Text>
            <Text style={styles.desc}>「{groupName}」に参加しました</Text>
            <TouchableOpacity style={styles.btn} onPress={goHome}>
              <Text style={styles.btnText}>グループを見る</Text>
            </TouchableOpacity>
          </>
        )}

        {status === 'error' && (
          <>
            <Ionicons name="close-circle" size={64} color="#EF4444" />
            <Text style={styles.title}>参加できませんでした</Text>
            <Text style={styles.desc}>招待コードが無効か、グループが存在しません</Text>
            <TouchableOpacity style={styles.btn} onPress={handleJoin}>
              <Text style={styles.btnText}>もう一度試す</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={goHome}>
              <Text style={styles.cancelBtnText}>戻る</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8F4FC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 28,
    padding: 32,
    alignItems: 'center',
    width: '85%',
    shadowColor: '#A78BFA',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 8,
    gap: 12,
  },
  emoji: { fontSize: 64 },
  title: { fontSize: 22, fontWeight: '800', color: colors.text, textAlign: 'center' },
  desc: { fontSize: 14, color: colors.textSecondary, textAlign: 'center' },
  code: { fontSize: 28, fontWeight: '900', color: colors.primary, letterSpacing: 6, marginVertical: 4 },
  btn: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 40,
    alignItems: 'center',
    width: '100%',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
    marginTop: 4,
  },
  btnText: { fontSize: 16, fontWeight: '800', color: '#FFFFFF' },
  cancelBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  cancelBtnText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
});
