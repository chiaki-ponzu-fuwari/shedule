import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { AccountDeletionControl } from '../../components/settings/AccountDeletionControl';

const mockDeleteAccount = jest.fn();
const mockRecover = jest.fn();

jest.mock('../../hooks/useAccountDeletion', () => ({
  useAccountDeletion: () => ({ deleteAccount: mockDeleteAccount, recover: mockRecover }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../constants/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => ({
      'account.delete.action': 'アカウントとデータを削除',
      'account.delete.title': 'アカウント削除',
      'account.delete.intro': '取り消せません',
      'account.delete.personal': '予定',
      'account.delete.shared': '共有',
      'account.delete.local': '端末',
      'account.delete.external': '外部の予定は残ります',
      'account.delete.reauth': `${values?.provider}でもう一度本人確認`,
      'account.delete.confirm': '内容を確認して削除',
      'account.delete.working': '削除中',
      'account.delete.completedTitle': '削除が完了しました',
      'account.delete.completedBody': '削除しました',
      'account.delete.close': 'ゲスト利用に戻る',
      'common.cancel': 'キャンセル',
    } as Record<string, string>)[key] ?? key,
  }),
}));

describe('AccountDeletionControl', () => {
  beforeEach(() => {
    mockDeleteAccount.mockReset();
    mockRecover.mockReset();
  });

  test('keeps deletion behind a second confirmation and passes the exact account', async () => {
    mockDeleteAccount.mockResolvedValue({
      status: 'deleted',
      requestId: 'request-1',
      manualRevocationRequired: false,
    });
    const view = render(<AccountDeletionControl ownerId="user-1" provider="google" />);

    fireEvent.press(view.getByLabelText('アカウントとデータを削除'));
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    fireEvent.press(view.getByLabelText('内容を確認して削除'));

    await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalledWith({
      ownerId: 'user-1',
      provider: 'google',
    }));
    expect(await view.findByText('削除が完了しました')).toBeTruthy();
  });

  test('does not expose an account deletion action without a server identity', () => {
    const view = render(<AccountDeletionControl ownerId={null} provider={null} />);
    expect(view.queryByLabelText('アカウントとデータを削除')).toBeNull();
  });
});
