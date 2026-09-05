import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet } from 'react-native';
import { useGoogleCalendarAutoSync } from '../hooks/useGoogleCalendarAutoSync';
import { useSupabaseAuth } from '../hooks/useSupabaseAuth';

export default function RootLayout() {
  useSupabaseAuth();
  useGoogleCalendarAutoSync();

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
});
