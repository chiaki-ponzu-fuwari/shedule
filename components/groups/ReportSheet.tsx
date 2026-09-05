import React, { useEffect, useRef, useState } from 'react';
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../constants/colors';
import { useTranslation } from '../../constants/i18n';
import {
  MODERATION_REASONS,
  type ModerationReason,
} from '../../store/moderationStore';
import type { GroupMember } from '../../types';

const SUPPORT_EMAIL = 'herac.7.app@gmail.com';

interface Props {
  visible: boolean;
  member: GroupMember;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (input: { reason: ModerationReason; detail: string }) => void | Promise<void>;
}

export function ReportSheet({ visible, member, busy = false, onClose, onSubmit }: Props) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<ModerationReason | null>(null);
  const [detail, setDetail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    if (!visible) return;
    setReason(null);
    setDetail('');
  }, [visible, member.id]);

  const pending = busy || submitting;
  const submit = async () => {
    if (!reason || pending || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit({ reason, detail: detail.trim().slice(0, 500) });
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

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
            <View style={styles.titleCopy}>
              <Text style={styles.title}>{t('moderation.reportTitle')}</Text>
              <Text style={styles.subtitle}>{t('moderation.reportTarget', { name: member.name })}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              onPress={onClose}
              hitSlop={12}
              style={styles.close}
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>{t('moderation.reason')}</Text>
            <View style={styles.reasonGrid}>
              {MODERATION_REASONS.map((item) => {
                const selected = reason === item;
                const label = t(`moderation.reason.${item}`);
                return (
                  <Pressable
                    key={item}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityState={{ selected }}
                    onPress={() => setReason(item)}
                    style={[styles.reason, selected && styles.reasonSelected]}
                  >
                    <Text style={[styles.reasonText, selected && styles.reasonTextSelected]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.label}>{t('moderation.detail')}</Text>
            <TextInput
              accessibilityLabel={t('moderation.detail')}
              multiline
              maxLength={500}
              value={detail}
              onChangeText={setDetail}
              placeholder={t('moderation.detailPlaceholder')}
              placeholderTextColor={colors.textLight}
              style={styles.input}
              textAlignVertical="top"
            />
            <Text style={styles.counter}>{detail.length}/500</Text>

            <View style={styles.notice}>
              <Ionicons name="lock-closed-outline" size={16} color={colors.primary} />
              <Text style={styles.noticeText}>{t('moderation.reportPrivacy')}</Text>
            </View>
            <Pressable
              accessibilityRole="link"
              hitSlop={8}
              onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=Recoto%20Safety`).catch(() => undefined)}
            >
              <Text style={styles.support}>{SUPPORT_EMAIL}</Text>
            </Pressable>
          </ScrollView>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('moderation.submitReport')}
            accessibilityState={{ disabled: !reason || pending, busy: pending }}
            disabled={!reason || pending}
            onPress={() => void submit().catch(() => undefined)}
            style={({ pressed }) => [
              styles.submit,
              (!reason || pending) && styles.submitDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.submitText}>{t('moderation.submitReport')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.45)' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { maxHeight: '86%', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 28, borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: '#FFFFFF' },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#BFDBFE', alignSelf: 'center', marginBottom: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  titleCopy: { flex: 1 },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  scroll: { marginTop: 8 },
  label: { color: colors.textSecondary, fontSize: 13, fontWeight: '700', marginTop: 12, marginBottom: 8 },
  reasonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  reason: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: '#DCE7FA', backgroundColor: '#FFFFFF' },
  reasonSelected: { borderColor: colors.primary, backgroundColor: '#EAF2FF' },
  reasonText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  reasonTextSelected: { color: colors.primary, fontWeight: '800' },
  input: { minHeight: 92, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 12, borderWidth: 1, borderColor: '#DCE7FA', color: colors.text, fontSize: 14, lineHeight: 20 },
  counter: { alignSelf: 'flex-end', color: colors.textLight, fontSize: 11, marginTop: 4 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 12, padding: 11, borderRadius: 12, backgroundColor: '#EFF6FF' },
  noticeText: { flex: 1, color: colors.textSecondary, fontSize: 11, lineHeight: 17 },
  support: { color: colors.primary, fontSize: 12, fontWeight: '700', textDecorationLine: 'underline', marginTop: 10 },
  submit: { minHeight: 50, alignItems: 'center', justifyContent: 'center', marginTop: 16, borderRadius: 14, backgroundColor: colors.primary },
  submitDisabled: { opacity: 0.45 },
  submitText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  pressed: { opacity: 0.7 },
});
