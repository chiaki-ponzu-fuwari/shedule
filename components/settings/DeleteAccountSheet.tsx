import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';

export type DeleteAccountSheetPhase = 'confirm' | 'working' | 'pending' | 'completed';

export function DeleteAccountSheet({
  visible,
  phase,
  providerLabel,
  error,
  manualRevocationRequired = false,
  onCancel,
  onConfirm,
  onRetry,
  onClose,
}: {
  visible: boolean;
  phase: DeleteAccountSheetPhase;
  providerLabel: string | null;
  error?: string | null;
  manualRevocationRequired?: boolean;
  onCancel(): void;
  onConfirm(): void;
  onRetry(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const busy = phase === 'working';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      presentationStyle="overFullScreen"
      onRequestClose={busy ? () => undefined : onCancel}
    >
      <View style={styles.backdrop}>
        <View
          accessibilityViewIsModal
          accessibilityLiveRegion="polite"
          style={styles.sheet}
        >
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.content}>
            {phase === 'completed' ? (
              <>
                <View style={[styles.iconCircle, styles.iconCircleDone]}>
                  <Ionicons name="checkmark" size={28} color="#166534" />
                </View>
                <Text accessibilityRole="header" style={styles.title}>
                  {t('account.delete.completedTitle')}
                </Text>
                <Text style={styles.body}>{t('account.delete.completedBody')}</Text>
                {manualRevocationRequired ? (
                  <View style={styles.warningBox}>
                    <Ionicons name="shield-outline" size={18} color="#92400E" />
                    <Text style={styles.warningText}>{t('account.delete.manualRevoke')}</Text>
                  </View>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  onPress={onClose}
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
                >
                  <Text style={styles.primaryLabel}>{t('account.delete.close')}</Text>
                </Pressable>
              </>
            ) : phase === 'pending' ? (
              <>
                <View style={[styles.iconCircle, styles.iconCirclePending]}>
                  <Ionicons name="cloud-offline-outline" size={27} color="#92400E" />
                </View>
                <Text accessibilityRole="header" style={styles.title}>
                  {t('account.delete.pendingTitle')}
                </Text>
                <Text style={styles.body}>{t('account.delete.pendingBody')}</Text>
                {error ? <Text style={styles.errorText}>{error}</Text> : null}
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={onCancel}
                    style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.secondaryLabel}>{t('account.delete.later')}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={onRetry}
                    style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.primaryLabel}>{t('account.delete.retry')}</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <View style={styles.iconCircle}>
                  <Ionicons name="trash-outline" size={27} color="#B91C1C" />
                </View>
                <Text accessibilityRole="header" style={styles.title}>
                  {t('account.delete.title')}
                </Text>
                <Text style={styles.body}>{t('account.delete.intro')}</Text>

                <View style={styles.deleteList}>
                  {[
                    'account.delete.personal',
                    'account.delete.shared',
                    'account.delete.local',
                  ].map((key) => (
                    <View key={key} style={styles.deleteRow}>
                      <Ionicons name="remove-circle-outline" size={17} color="#B91C1C" />
                      <Text style={styles.deleteText}>{t(key)}</Text>
                    </View>
                  ))}
                </View>

                <View style={styles.infoBox}>
                  <Ionicons name="information-circle-outline" size={19} color="#1D4ED8" />
                  <Text style={styles.infoText}>{t('account.delete.external')}</Text>
                </View>
                <Text style={styles.reauthText}>
                  {providerLabel
                    ? t('account.delete.reauth', { provider: providerLabel })
                    : t('account.delete.guest')}
                </Text>

                {busy ? (
                  <View accessibilityState={{ busy: true }} style={styles.busyRow}>
                    <ActivityIndicator color="#FFFFFF" />
                    <Text style={styles.primaryLabel}>{t('account.delete.working')}</Text>
                  </View>
                ) : (
                  <View style={styles.actions}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={onCancel}
                      style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.secondaryLabel}>{t('common.cancel')}</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('account.delete.confirm')}
                      onPress={onConfirm}
                      style={({ pressed }) => [styles.dangerButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.dangerLabel}>{t('account.delete.confirm')}</Text>
                    </Pressable>
                  </View>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(15, 23, 42, 0.46)',
  },
  sheet: {
    maxHeight: '90%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: '#FFFFFF',
  },
  handle: {
    alignSelf: 'center',
    width: 42,
    height: 4,
    marginTop: 10,
    borderRadius: 2,
    backgroundColor: '#CBD5E1',
  },
  content: { padding: 22, paddingBottom: 36 },
  iconCircle: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: '#FEE2E2',
  },
  iconCircleDone: { backgroundColor: '#DCFCE7' },
  iconCirclePending: { backgroundColor: '#FEF3C7' },
  title: { marginTop: 14, color: colors.text, fontSize: 20, fontWeight: '800' },
  body: { marginTop: 8, color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
  deleteList: { gap: 9, marginTop: 18, padding: 14, borderRadius: 14, backgroundColor: '#FFF7F7' },
  deleteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  deleteText: { flex: 1, color: '#7F1D1D', fontSize: 13, lineHeight: 19 },
  infoBox: { flexDirection: 'row', gap: 8, marginTop: 14, padding: 12, borderRadius: 12, backgroundColor: '#EFF6FF' },
  infoText: { flex: 1, color: '#1E3A8A', fontSize: 12, lineHeight: 18 },
  reauthText: { marginTop: 14, color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  warningBox: { flexDirection: 'row', gap: 8, marginTop: 16, padding: 12, borderRadius: 12, backgroundColor: '#FFF7E6' },
  warningText: { flex: 1, color: '#78350F', fontSize: 12, lineHeight: 18 },
  errorText: { marginTop: 12, color: '#991B1B', fontSize: 12, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 22 },
  primaryButton: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.primary,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
  },
  dangerButton: {
    flex: 1.35,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#B91C1C',
  },
  busyRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    marginTop: 22,
    borderRadius: 12,
    backgroundColor: '#991B1B',
  },
  primaryLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  secondaryLabel: { color: colors.text, fontSize: 14, fontWeight: '700' },
  dangerLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.75 },
});
