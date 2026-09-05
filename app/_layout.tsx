import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../constants/colors';
import { useGoogleCalendarAutoSync } from '../hooks/useGoogleCalendarAutoSync';
import { useLocalStoresHydration } from '../hooks/useLocalStoresHydrated';
import { useSupabaseAuth } from '../hooks/useSupabaseAuth';

export function HydratedApplication() {
  useSupabaseAuth();
  useGoogleCalendarAutoSync();

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="join/[code]" />
    </Stack>
  );
}

export function HydrationGate() {
  const { status, retry } = useLocalStoresHydration();

  if (status === 'ready') {
    return <HydratedApplication />;
  }

  if (status === 'failed') {
    return (
      <View style={styles.recovery}>
        <Text style={styles.recoveryTitle}>保存したデータを読み込めませんでした</Text>
        <Text style={styles.recoveryBody}>
          端末内のデータは削除されていません。時間をおいて、もう一度お試しください。
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={retry}
          style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
        >
          <Text style={styles.retryLabel}>再試行</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.boot}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="dark" backgroundColor="#FFF0F5" />
      <HydrationGate />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  recovery: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 32,
    backgroundColor: colors.background,
  },
  recoveryTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  recoveryBody: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  retryButton: {
    minWidth: 120,
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.primary,
  },
  retryButtonPressed: { opacity: 0.8 },
  retryLabel: { color: colors.textInverse, fontSize: 15, fontWeight: '700', textAlign: 'center' },
});
