import React from 'react';
import {
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import { configuredLegalLinks } from '../../lib/legalLinks';
import type { GroupMember } from '../../types';

const SUPPORT_EMAIL = 'herac.7.app@gmail.com';

export type GroupMemberActionRole = 'owner' | 'member' | 'self';

interface Props {
  visible: boolean;
  role: GroupMemberActionRole;
  member: GroupMember;
  blocked?: boolean;
  busy?: boolean;
  onClose: () => void;
  onReport?: (member: GroupMember) => void;
  onBlock?: (userId: string) => void;
  onUnblock?: (userId: string) => void;
  onRemoveAndBan?: (userId: string) => void;
}

export function GroupMemberActions({
  visible,
  role,
  member,
  blocked = false,
  busy = false,
  onClose,
  onReport,
  onBlock,
  onUnblock,
  onRemoveAndBan,
}: Props) {
  const { t } = useTranslation();
  const legalLinks = configuredLegalLinks();
  const canAct = role !== 'self';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={styles.backdrop} />
        </TouchableWithoutFeedback>
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={[styles.avatar, { backgroundColor: member.color }]}>
              <Text style={styles.avatarText}>{member.name?.charAt(0) || '?'}</Text>
            </View>
            <View style={styles.headingCopy}>
              <Text style={styles.title}>{member.name}</Text>
              <Text style={styles.subtitle}>{t('moderation.memberActions')}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              hitSlop={12}
              onPress={onClose}
              style={styles.iconButton}
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          {canAct ? (
            <View style={styles.actions}>
              <ActionButton
                label={t('moderation.report')}
                icon="flag-outline"
                disabled={busy || !onReport}
                onPress={() => onReport?.(member)}
              />
              <ActionButton
                label={blocked ? t('moderation.unblock') : t('moderation.block')}
                icon={blocked ? 'eye-outline' : 'ban-outline'}
                disabled={busy || (blocked ? !onUnblock : !onBlock)}
                onPress={() => (blocked ? onUnblock?.(member.id) : onBlock?.(member.id))}
              />
              {role === 'owner' ? (
                <ActionButton
                  label={t('moderation.removeAndBan')}
                  icon="person-remove-outline"
                  destructive
                  disabled={busy || !onRemoveAndBan}
                  onPress={() => onRemoveAndBan?.(member.id)}
                />
              ) : null}
            </View>
          ) : (
            <Text style={styles.selfNote}>{t('moderation.selfNote')}</Text>
          )}

          <View style={styles.safetyBox}>
            <Ionicons name="shield-checkmark-outline" size={19} color={colors.primary} />
            <View style={styles.safetyCopy}>
              <Text style={styles.safetyTitle}>{t('moderation.safetyHelp')}</Text>
              {legalLinks ? (
                <Pressable
                  accessibilityRole="link"
                  hitSlop={8}
                  onPress={() => void Linking.openURL(legalLinks.community).catch(() => undefined)}
                >
                  <Text style={styles.link}>{t('legal.community')}</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="link"
                hitSlop={8}
                onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=Recoto%20Safety`).catch(() => undefined)}
              >
                <Text style={styles.link}>{SUPPORT_EMAIL}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ActionButton({
  label,
  icon,
  destructive = false,
  disabled,
  onPress,
}: {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  destructive?: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        destructive && styles.actionDestructive,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Ionicons name={icon} size={20} color={destructive ? '#B91C1C' : colors.primary} />
      <Text style={[styles.actionText, destructive && styles.actionTextDestructive]}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color={colors.textLight} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.45)' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 28,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: '#FFFFFF',
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#BFDBFE', alignSelf: 'center', marginBottom: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  headingCopy: { flex: 1 },
  title: { color: colors.text, fontSize: 17, fontWeight: '800' },
  subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  actions: { marginTop: 18, borderTopWidth: 1, borderTopColor: colors.divider },
  action: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: colors.divider },
  actionDestructive: { backgroundColor: '#FFF7F7', marginHorizontal: -10, paddingHorizontal: 10 },
  actionText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '700' },
  actionTextDestructive: { color: '#B91C1C' },
  pressed: { opacity: 0.68 },
  disabled: { opacity: 0.45 },
  selfNote: { color: colors.textSecondary, fontSize: 13, lineHeight: 20, marginTop: 18 },
  safetyBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 18, padding: 13, borderRadius: 14, backgroundColor: '#EFF6FF' },
  safetyCopy: { flex: 1, gap: 5 },
  safetyTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  link: { color: colors.primary, fontSize: 12, fontWeight: '700', textDecorationLine: 'underline' },
});
