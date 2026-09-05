import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import { configuredLegalLinks } from '../../lib/legalLinks';

const SUPPORT_EMAIL = 'herac.7.app@gmail.com';

export function LegalLinksCard() {
  const { t } = useTranslation();
  const links = configuredLegalLinks();
  const rows = links
    ? [
        ['shield-checkmark-outline', t('legal.privacy'), links.privacy],
        ['document-text-outline', t('legal.terms'), links.terms],
        ['people-outline', t('legal.community'), links.community],
        ['help-circle-outline', t('legal.support'), links.support],
        ['trash-outline', t('legal.deletion'), links.deletion],
      ] as const
    : [];

  const open = (url: string) => {
    void Linking.openURL(url).catch(() => undefined);
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t('legal.title')}</Text>
      <View style={styles.card}>
        {rows.map(([icon, label, url], index) => (
          <Pressable
            key={label}
            accessibilityRole="link"
            accessibilityLabel={label}
            onPress={() => open(url)}
            style={({ pressed }) => [
              styles.row,
              index < rows.length - 1 && styles.rowBorder,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons name={icon} size={19} color={colors.primary} accessible={false} />
            <Text style={styles.label}>{label}</Text>
            <Ionicons name="open-outline" size={16} color={colors.textLight} accessible={false} />
          </Pressable>
        ))}
        {!links ? <Text style={styles.unavailable}>{t('legal.unavailable')}</Text> : null}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('legal.email')}
          onPress={() => open(`mailto:${SUPPORT_EMAIL}`)}
          style={({ pressed }) => [styles.email, pressed && styles.pressed]}
        >
          <Ionicons name="mail-outline" size={17} color={colors.textSecondary} accessible={false} />
          <Text style={styles.emailText}>{SUPPORT_EMAIL}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 16, marginTop: 20 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: colors.text, marginBottom: 12 },
  card: {
    overflow: 'hidden',
    borderRadius: 16,
    paddingHorizontal: 16,
    backgroundColor: colors.card,
    shadowColor: '#3B82F6',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 2,
  },
  row: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 11 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
  label: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  unavailable: { color: colors.textSecondary, fontSize: 12, lineHeight: 18, paddingVertical: 14 },
  email: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
  },
  emailText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.65 },
});
