import { Stack, usePathname } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../constants/colors';
import { useAccountBootstrap } from '../hooks/useAccountBootstrap';
import { useAccountCloudSync } from '../hooks/useAccountCloudSync';
import { useGoogleCalendarAutoSync } from '../hooks/useGoogleCalendarAutoSync';
import { useLocalStoresHydration } from '../hooks/useLocalStoresHydrated';
import { useSupabaseAuth } from '../hooks/useSupabaseAuth';
import { useTranslation } from '../constants/i18n';

export function HydratedApplication() {
  const { t } = useTranslation();
  useSupabaseAuth();
  const bootstrap = useAccountBootstrap();

  if (bootstrap.status === 'ready' || bootstrap.status === 'safe-failure') {
    return <BootstrappedApplication />;
  }

  if (bootstrap.status === 'blocked') {
    return (
      <View style={styles.recovery}>
        <Text accessibilityLiveRegion="polite" style={styles.recoveryTitle}>
          {t('app.bootstrap.blockedTitle')}
        </Text>
        <Text style={styles.recoveryBody}>{t('app.bootstrap.blockedBody')}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void bootstrap.retry()}
          style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
        >
          <Text style={styles.retryLabel}>{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.boot}>
      <ActivityIndicator accessibilityLabel={t('app.loading')} color={colors.primary} />
    </View>
  );
}

export function BootstrappedApplication() {
  useGoogleCalendarAutoSync();
  useAccountCloudSync();

  return <ApplicationStack />;
}

export function ApplicationStack() {

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="join/[code]" />
      <Stack.Screen name="auth/callback" />
    </Stack>
  );
}

export function HydrationGate() {
  const { t } = useTranslation();
  const { status, retry } = useLocalStoresHydration();

  if (status === 'ready') {
    return <HydratedApplication />;
  }

  if (status === 'failed') {
    return (
      <View style={styles.recovery}>
        <Text accessibilityLiveRegion="polite" style={styles.recoveryTitle}>
          {t('app.hydration.failedTitle')}
        </Text>
        <Text style={styles.recoveryBody}>
          {t('app.hydration.failedBody')}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={retry}
          style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
        >
          <Text style={styles.retryLabel}>{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.boot}>
      <ActivityIndicator accessibilityLabel={t('app.loading')} color={colors.primary} />
    </View>
  );
}

export default function RootLayout() {
  const pathname = usePathname();
  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="dark" backgroundColor="#FFF0F5" />
      {pathname === '/auth/callback' ? <ApplicationStack /> : <HydrationGate />}
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
