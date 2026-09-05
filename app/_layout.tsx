import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { colors } from '../constants/colors';
import { useGoogleCalendarAutoSync } from '../hooks/useGoogleCalendarAutoSync';
import { useLocalStoresHydrated } from '../hooks/useLocalStoresHydrated';
import { useSupabaseAuth } from '../hooks/useSupabaseAuth';

export default function RootLayout() {
  useSupabaseAuth();
  useGoogleCalendarAutoSync();
  const localStoresHydrated = useLocalStoresHydrated();

  if (!localStoresHydrated) {
    return (
      <GestureHandlerRootView style={styles.root}>
        <StatusBar style="dark" backgroundColor="#FFF0F5" />
        <View style={styles.boot}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </GestureHandlerRootView>
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
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
});
