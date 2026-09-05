import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import {
  createProductionAccountAuthGateway,
  getAccountOAuthOperationJournal,
} from '../../hooks/useAccountAuth';
import { inboxAccountOAuthCallback } from '../../lib/account/supabaseAuthGateway';
import { useAccountStore } from '../../store/accountStore';

export default function AccountAuthCallbackScreen() {
  const { t } = useTranslation();
  const linkedUrl = Linking.useURL();
  const incomingUrl = Platform.OS === 'web' && typeof window !== 'undefined'
    ? window.location.href
    : linkedUrl;
  const markConnected = useAccountStore((state) => state.markConnected);
  const cancelConnection = useAccountStore((state) => state.cancelConnection);
  const markError = useAccountStore((state) => state.markError);
  const [error, setError] = useState<string | null>(null);
  const [browserCompleted, setBrowserCompleted] = useState(false);

  useEffect(() => {
    let active = true;
    const complete = async () => {
      if (!incomingUrl) {
        throw new Error('OAuth callback URL is unavailable');
      }
      if (Platform.OS === 'web') {
        // Same-origin storage is shared with the opener. Commit and read back
        // the exact URL first so an opener refresh cannot lose the PKCE result.
        await inboxAccountOAuthCallback(
          getAccountOAuthOperationJournal(),
          incomingUrl,
        );
        let completion: ReturnType<typeof WebBrowser.maybeCompleteAuthSession>;
        try {
          completion = WebBrowser.maybeCompleteAuthSession();
        } catch {
          completion = { type: 'failed', message: 'The opener is unavailable' };
        }
        if (!active) return;
        if (completion.type === 'success') {
          setBrowserCompleted(true);
          return;
        }
      }
      const gateway = createProductionAccountAuthGateway();
      const result = await gateway.consumeOAuthCallback(incomingUrl, 'route');
      if (!active) return;
      if (result.status === 'cancelled') {
        cancelConnection();
      } else if (result.status === 'main-linked') {
        markConnected({
          userId: result.userId,
          provider: result.provider,
          email: result.email,
        });
      } else if (result.status === 'target-authenticated') {
        const resumed = await gateway.resumePendingOperation();
        if (!active) return;
        if (resumed.status !== 'resumed') {
          throw new Error('OAuth operation could not be resumed safely');
        }
        markConnected({
          userId: resumed.userId,
          provider: resumed.provider,
          email: resumed.email ?? result.email,
        });
      }
      router.replace('/(tabs)/settings');
    };

    void complete().catch((caught) => {
      if (!active) return;
      const message = t('account.callback.error');
      markError(message);
      setError(message);
    });
    return () => {
      active = false;
    };
  }, [cancelConnection, incomingUrl, markConnected, markError, t]);

  if (browserCompleted) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <Ionicons name="checkmark-circle" size={42} color={colors.primary} />
          <Text style={styles.title}>{t('account.callback.returning')}</Text>
          <Text style={styles.body}>{t('account.callback.close')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {error ? (
          <>
            <View style={styles.errorIcon}>
              <Ionicons name="cloud-offline-outline" size={26} color="#B45309" />
            </View>
            <Text style={styles.title}>{t('account.callback.failed')}</Text>
            <Text style={styles.body}>{error}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('account.callback.settings')}
              onPress={() => router.replace('/(tabs)/settings')}
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            >
              <Text style={styles.buttonText}>{t('account.callback.settings')}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.title}>{t('account.callback.checking')}</Text>
            <Text style={styles.body}>{t('account.callback.safe')}</Text>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  errorIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FEF3C7',
  },
  title: { color: colors.text, fontSize: 19, fontWeight: '800', textAlign: 'center' },
  body: {
    maxWidth: 380,
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  button: {
    minWidth: 152,
    marginTop: 8,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.primary,
  },
  buttonPressed: { opacity: 0.76 },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', textAlign: 'center' },
});
