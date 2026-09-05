import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { DeleteAccountSheet } from '../../components/settings/DeleteAccountSheet';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../constants/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => ({
      'account.delete.title': 'アカウントとクラウドデータを削除',
      'account.delete.intro': 'この操作は取り消せません。',
      'account.delete.personal': 'クラウドの予定',
      'account.delete.shared': '共有投稿',
      'account.delete.local': '端末データ',
      'account.delete.external': '外部サービス側にある元の予定は削除されません。',
      'account.delete.reauth': `${values?.provider}でもう一度本人確認してから削除します。`,
      'account.delete.confirm': '内容を確認して削除',
      'account.delete.completedTitle': '削除が完了しました',
      'account.delete.completedBody': '削除しました。',
      'account.delete.manualRevoke': 'セキュリティ設定から連携を解除してください。',
      'account.delete.close': 'ゲスト利用に戻る',
      'common.cancel': 'キャンセル',
    } as Record<string, string>)[key] ?? key,
  }),
}));

describe('DeleteAccountSheet', () => {
  test('explains scope and waits for a separate destructive confirmation', () => {
    const onConfirm = jest.fn();
    const view = render(
      <DeleteAccountSheet
        visible
        phase="confirm"
        providerLabel="Google"
        onCancel={jest.fn()}
        onConfirm={onConfirm}
        onRetry={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(view.getByText(/外部サービス側にある元の予定は削除されません/)).toBeTruthy();
    expect(view.getByText(/Googleでもう一度本人確認/)).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.press(view.getByLabelText('内容を確認して削除'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('keeps manual provider-revocation guidance visible after local completion', () => {
    const view = render(
      <DeleteAccountSheet
        visible
        phase="completed"
        providerLabel="Apple"
        manualRevocationRequired
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
        onRetry={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(view.getByText(/セキュリティ設定から/)).toBeTruthy();
  });
});
