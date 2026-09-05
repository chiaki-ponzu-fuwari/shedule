import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BackupIdentityProvider } from '../../lib/account/connectBackupIdentity';
import type { AccountDeletionControllerResult } from '../../lib/account/accountDeletionController';
import { useAccountDeletion } from '../../hooks/useAccountDeletion';
import { useTranslation } from '../../constants/i18n';
import { DeleteAccountSheet, type DeleteAccountSheetPhase } from './DeleteAccountSheet';

interface DeletionTarget {
  ownerId: string;
  provider: BackupIdentityProvider | null;
}

export function AccountDeletionControl({
  ownerId,
  provider,
}: {
  ownerId: string | null;
  provider: BackupIdentityProvider | null;
}) {
  const { t } = useTranslation();
  const controller = useAccountDeletion();
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<DeleteAccountSheetPhase>('confirm');
  const [manualRevocationRequired, setManualRevocationRequired] = useState(false);
  const targetRef = useRef<DeletionTarget | null>(null);

  const open = () => {
    if (!ownerId) return;
    targetRef.current = { ownerId, provider };
    setManualRevocationRequired(false);
    setPhase('confirm');
    setVisible(true);
  };

  const applyResult = (result: AccountDeletionControllerResult) => {
    if (result.status === 'deleted') {
      setManualRevocationRequired(result.manualRevocationRequired);
      setPhase('completed');
      return;
    }
    if (result.status === 'deletion-pending' || result.status === 'local-cleanup-pending') {
      setPhase('pending');
      return;
    }
    if (result.status === 'confirmation-required') {
      setPhase('confirm');
      return;
    }
    if (result.status === 'none') {
      setVisible(false);
      targetRef.current = null;
      return;
    }
    setPhase('confirm');
  };

  const confirm = async () => {
    const target = targetRef.current;
    if (!target || phase === 'working') return;
    setPhase('working');
    try {
      applyResult(await controller.deleteAccount(target));
    } catch {
      setPhase('pending');
    }
  };

  const retry = async () => {
    const target = targetRef.current;
    if (!target || phase === 'working') return;
    setPhase('working');
    try {
      const recovered = await controller.recover();
      if (recovered.status === 'confirmation-required' || recovered.status === 'none') {
        applyResult(await controller.deleteAccount(target));
      } else {
        applyResult(recovered);
      }
    } catch {
      setPhase('pending');
    }
  };

  const dismiss = () => {
    if (phase === 'working') return;
    setVisible(false);
  };

  const closeCompleted = () => {
    setVisible(false);
    targetRef.current = null;
    setPhase('confirm');
  };

  return (
    <View>
      {ownerId ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('account.delete.action')}
          onPress={open}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text style={styles.actionLabel}>{t('account.delete.action')}</Text>
        </Pressable>
      ) : null}
      <DeleteAccountSheet
        visible={visible}
        phase={phase}
        providerLabel={targetRef.current?.provider === 'apple'
          ? 'Apple'
          : targetRef.current?.provider === 'google'
            ? 'Google'
            : null}
        manualRevocationRequired={manualRevocationRequired}
        onCancel={dismiss}
        onConfirm={() => void confirm()}
        onRetry={() => void retry()}
        onClose={closeCompleted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    backgroundColor: '#FFF7F7',
  },
  actionLabel: { color: '#B91C1C', fontSize: 13, fontWeight: '800' },
  pressed: { opacity: 0.72 },
});
