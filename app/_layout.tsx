import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useEffect } from 'react';
import { requestNotificationPermission } from '../utils/notifications';
import { useGoogleCalendarAutoSync } from '../hooks/useGoogleCalendarAutoSync';
import { useSupabaseAuth } from '../hooks/useSupabaseAuth';

export default function RootLayout() {
  const { ready, error } = useSupabaseAuth();
  useGoogleCalendarAutoSync();

  useEffect(() => {
    requestNotificationPermission();
  }, []);

  if (!ready) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color="#FF6B9D" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.boot}>
        <Text style={styles.bootErr}>
          Supabase 認証エラー{__DEV__ ? `: ${error}` : 'が発生しました。設定を確認してください。'}
        </Text>
        <Text style={styles.bootHint}>
          Dashboard → Authentication → Providers で Anonymous を有効にし、SQL マイグレーションを適用してください。
        </Text>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="dark" backgroundColor="#FFF0F5" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="join/[code]" />
      </Stack>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  boot: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#FFF0F5' },
  bootErr: { color: '#B91C1C', textAlign: 'center', marginBottom: 12 },
  bootHint: { color: '#64748B', textAlign: 'center', fontSize: 13 },
});
