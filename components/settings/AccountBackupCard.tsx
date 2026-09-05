import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as AppleAuthentication from 'expo-apple-authentication';
import { colors } from '../../constants/colors';
import { dateLocaleTag, useTranslation } from '../../constants/i18n';
import { useAccountAuth } from '../../hooks/useAccountAuth';
import type { BackupIdentityProvider } from '../../lib/account/connectBackupIdentity';
import { selectAccountBackupStatus, useAccountStore } from '../../store/accountStore';
import { AccountDeletionControl } from './AccountDeletionControl';

const STATUS_KEY = {
  'local-only': 'account.status.local',
  connecting: 'account.status.connecting',
  pending: 'account.status.pending',
  syncing: 'account.status.syncing',
  synced: 'account.status.synced',
  offline: 'account.status.offline',
  'reauth-required': 'account.status.reauth',
  'deletion-pending': 'account.status.deletion',
  error: 'account.status.error',
} as const;

function accountErrorKey(status: ReturnType<typeof selectAccountBackupStatus>) {
  if (status === 'offline') return 'account.error.offline';
  if (status === 'reauth-required') return 'account.error.reauth';
  return 'account.error.generic';
}

export function AccountBackupCard() {
  const { t, locale } = useTranslation();
  const account = useAccountStore();
  const { connect, reauthenticate } = useAccountAuth();
  const status = selectAccountBackupStatus(account);
  const isConnected = account.mode === 'account-connected' || account.mode === 'deletion-pending';
  const isBusy = status === 'connecting';

  const startConnection = (provider: BackupIdentityProvider) => {
    void connect(provider).catch(() => undefined);
  };
  const startReauthentication = (provider: BackupIdentityProvider) => {
    if (!account.userId) return;
    void reauthenticate(provider, account.userId).catch(() => undefined);
  };

  const providerLabel =
    account.provider === 'apple' ? 'Apple' : account.provider === 'google' ? 'Google' : null;
  const statusTone =
    status === 'synced'
      ? styles.statusGood
      : status === 'offline' || status === 'error' || status === 'reauth-required'
        ? styles.statusWarn
        : styles.statusNeutral;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t('account.title')}</Text>
      <View style={styles.card}>
        <View style={styles.headingRow}>
          <View style={styles.cloudMark}>
            <Ionicons name="cloud-outline" size={24} color={colors.primary} />
          </View>
          <View style={styles.headingCopy}>
            <Text style={styles.heading}>{t('account.heading')}</Text>
            <Text style={styles.description}>{t('account.description')}</Text>
          </View>
        </View>

        <View
          accessibilityLiveRegion="polite"
          accessibilityState={{ busy: isBusy || status === 'syncing' }}
          style={[styles.statusStrip, statusTone]}
        >
          {isBusy || status === 'syncing' ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Ionicons
              name={status === 'synced' ? 'checkmark-circle' : status === 'offline' ? 'cloud-offline-outline' : 'ellipse'}
              size={15}
              color={status === 'synced' ? '#15803D' : status === 'offline' ? '#B45309' : colors.primary}
            />
          )}
          <Text style={styles.statusText}>{t(STATUS_KEY[status])}</Text>
        </View>

        {isConnected ? (
          <View style={styles.connectedBlock}>
            {account.provider && providerLabel ? (
              <View style={styles.identityRow}>
                <View style={[styles.providerMark, account.provider === 'apple' && styles.providerMarkApple]}>
                  {account.provider === 'apple' ? (
                    <Ionicons name="logo-apple" size={19} color="#FFFFFF" />
                  ) : (
                    <Text style={styles.providerMarkText}>G</Text>
                  )}
                </View>
                <View style={styles.identityCopy}>
                  <Text style={styles.identityName}>{t('account.savedWith', { provider: providerLabel })}</Text>
                  <Text style={styles.identityEmail} numberOfLines={1}>
                    {account.email || t('account.privateAddress')}
                  </Text>
                </View>
              </View>
            ) : null}
            {account.lastSyncedAt ? (
              <Text style={styles.lastSync}>
                {t('account.lastSaved', {
                  time: new Date(account.lastSyncedAt).toLocaleString(dateLocaleTag(locale)),
                })}
              </Text>
            ) : null}
            {status === 'reauth-required' && account.provider ? (
              <ProviderButton
                provider={account.provider}
                label={t('account.reauth', { provider: providerLabel! })}
                disabled={isBusy}
                onPress={() => startReauthentication(account.provider!)}
              />
            ) : null}
          </View>
        ) : (
          <>
            <View style={styles.localNotice}>
              <Ionicons name="phone-portrait-outline" size={18} color="#92400E" />
              <View style={styles.localNoticeCopy}>
                <Text style={styles.localNoticeTitle}>{t('account.localTitle')}</Text>
                <Text style={styles.localNoticeBody}>{t('account.localBody')}</Text>
              </View>
            </View>
            <View style={styles.actions}>
              <ProviderButton
                provider="google"
                label={t('account.googleButton')}
                disabled={isBusy}
                onPress={() => startConnection('google')}
              />
              <ProviderButton
                provider="apple"
                label={t('account.appleButton')}
                disabled={isBusy}
                onPress={() => startConnection('apple')}
              />
            </View>
          </>
        )}

        {account.error ? (
          <View accessibilityLiveRegion="polite" style={styles.errorBox}>
            <Text style={styles.errorText}>{t(accountErrorKey(status))}</Text>
          </View>
        ) : null}

        <AccountDeletionControl ownerId={account.userId} provider={account.provider} />

        <View style={styles.divider} />
        <Text style={styles.separationNote}>{t('account.calendarSeparate')}</Text>
      </View>
    </View>
  );
}

function ProviderButton({
  provider,
  label,
  disabled,
  onPress,
}: {
  provider: BackupIdentityProvider;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  if (provider === 'apple' && Platform.OS === 'ios') {
    return (
      <View
        accessible={false}
        style={[styles.appleFrame, disabled && styles.disabled]}
        pointerEvents={disabled ? 'none' : 'auto'}
      >
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={10}
          style={styles.appleButton}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled, busy: disabled }}
        />
      </View>
    );
  }

  const isApple = provider === 'apple';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.providerButton,
        isApple ? styles.appleFallbackButton : styles.googleButton,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.buttonLogo, isApple && styles.buttonLogoApple]}>
        {isApple ? (
          <Ionicons name="logo-apple" size={18} color="#FFFFFF" />
        ) : (
          <Text style={styles.buttonLogoText}>G</Text>
        )}
      </View>
      <Text style={[styles.providerButtonText, isApple && styles.appleFallbackText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 16, marginTop: 20 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: colors.text, marginBottom: 12 },
  card: {
    overflow: 'hidden', padding: 16, borderRadius: 16, backgroundColor: colors.card,
    borderWidth: 1, borderColor: '#DCE7FA', shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 2,
  },
  headingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cloudMark: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EAF2FF' },
  headingCopy: { flex: 1 },
  heading: { color: colors.text, fontSize: 16, fontWeight: '800' },
  description: { color: colors.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 3 },
  statusStrip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, marginTop: 14, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  statusNeutral: { backgroundColor: '#EAF2FF' },
  statusGood: { backgroundColor: '#DCFCE7' },
  statusWarn: { backgroundColor: '#FEF3C7' },
  statusText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  localNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 14, padding: 12, borderRadius: 12, backgroundColor: '#FFF7E6' },
  localNoticeCopy: { flex: 1 },
  localNoticeTitle: { color: '#78350F', fontSize: 13, fontWeight: '800' },
  localNoticeBody: { color: '#92400E', fontSize: 11, lineHeight: 17, marginTop: 2 },
  actions: { gap: 10, marginTop: 14 },
  providerButton: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 11, borderWidth: 1 },
  googleButton: { backgroundColor: '#FFFFFF', borderColor: '#CBD5E1' },
  appleFallbackButton: { backgroundColor: '#000000', borderColor: '#000000' },
  providerButtonText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  appleFallbackText: { color: '#FFFFFF' },
  buttonLogo: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: '#4285F4' },
  buttonLogoApple: { backgroundColor: '#000000' },
  buttonLogoText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' },
  appleFrame: { height: 46, borderRadius: 11, overflow: 'hidden' },
  appleButton: { width: '100%', height: 46 },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.76 },
  connectedBlock: { marginTop: 14 },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  providerMark: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: '#4285F4' },
  providerMarkApple: { backgroundColor: '#000000' },
  providerMarkText: { color: '#FFFFFF', fontSize: 17, fontWeight: '900' },
  identityCopy: { flex: 1 },
  identityName: { color: colors.text, fontSize: 14, fontWeight: '800' },
  identityEmail: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  lastSync: { color: colors.textLight, fontSize: 11, lineHeight: 16, marginTop: 9 },
  errorBox: { marginTop: 12, padding: 10, borderRadius: 10, backgroundColor: '#FFF7E6' },
  errorText: { color: '#92400E', fontSize: 11, lineHeight: 17 },
  divider: { height: 1, marginVertical: 14, backgroundColor: colors.divider },
  separationNote: { color: colors.textLight, fontSize: 11, lineHeight: 16 },
});
