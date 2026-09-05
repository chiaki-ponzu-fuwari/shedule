import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { AccountBackupCard } from '../../components/settings/AccountBackupCard';
import { initialAccountState, useAccountStore } from '../../store/accountStore';

const mockConnect = jest.fn(async () => ({ status: 'cancelled' as const }));
const mockReauthenticate = jest.fn(async () => ({ status: 'cancelled' as const }));

jest.mock('../../hooks/useAccountAuth', () => ({
  useAccountAuth: () => ({ connect: mockConnect, reauthenticate: mockReauthenticate }),
}));
jest.mock('../../components/settings/AccountDeletionControl', () => ({
  AccountDeletionControl: () => null,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../constants/i18n', () => ({
  useTranslation: () => ({
    locale: 'ja',
    t: (key: string, vars?: Record<string, string>) => {
      if (key === 'account.savedWith') return `${vars?.provider}で保存中`;
      if (key === 'account.reauth') return `${vars?.provider}で再ログイン`;
      return ({
      'account.title': 'データ保存用アカウント',
      'account.heading': '再インストール後も引き継ぐ',
      'account.description': '個人の予定をクラウドに保存',
      'account.status.local': '端末に保存中',
      'account.status.pending': 'クラウド保存待ち',
      'account.status.offline': 'オフライン',
      'account.status.deletion': 'アカウント削除を処理中',
      'account.error.offline': '通信の回復後に自動で保存を再開します。',
      'account.localTitle': 'いまはこの端末だけ',
      'account.localBody': 'アプリを削除すると復元できません',
      'account.googleButton': 'Googleで保存',
      'account.appleButton': 'Appleで保存',
      'account.privateAddress': 'メールアドレスは非公開',
      'account.calendarSeparate': 'これはGoogleカレンダー連携とは別です。',
      } as Record<string, string>)[key] ?? key;
    },
  }),
  dateLocaleTag: () => 'ja-JP',
}));
jest.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: 'AppleAuthenticationButton',
  AppleAuthenticationButtonType: { CONTINUE: 0 },
  AppleAuthenticationButtonStyle: { BLACK: 0 },
}));

describe('AccountBackupCard', () => {
  beforeEach(() => {
    mockConnect.mockClear();
    mockReauthenticate.mockClear();
    useAccountStore.setState(initialAccountState);
  });

  test('explains that guest data is currently stored on this device', () => {
    const view = render(<AccountBackupCard />);

    expect(view.getByText('いまはこの端末だけ')).toBeTruthy();
    expect(view.getByText(/Googleカレンダー連携とは別/)).toBeTruthy();
  });

  test('starts backup login only from an explicit provider button', () => {
    const view = render(<AccountBackupCard />);

    fireEvent.press(view.getByLabelText('Googleで保存'));
    expect(mockConnect).toHaveBeenCalledWith('google');
    expect(view.getByLabelText('Googleで保存').props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
  });

  test('keeps the native Apple control directly actionable by assistive technology', () => {
    const view = render(<AccountBackupCard />);

    const appleButtons = view.getAllByLabelText('Appleで保存');
    expect(appleButtons).toHaveLength(1);
    const appleButton = appleButtons[0];
    fireEvent.press(appleButton);

    expect(mockConnect).toHaveBeenCalledWith('apple');
    expect(appleButton.props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
  });

  test('shows connected identity and pending cloud state', () => {
    useAccountStore.getState().markConnected({
      userId: 'user-1',
      provider: 'apple',
      email: 'private@privaterelay.appleid.com',
    });

    const view = render(<AccountBackupCard />);
    expect(view.getByText('private@privaterelay.appleid.com')).toBeTruthy();
    expect(view.getByText('クラウド保存待ち')).toBeTruthy();
  });

  test('keeps a recoverable offline explanation visible', () => {
    useAccountStore.getState().markConnected({
      userId: 'user-1',
      provider: 'google',
      email: null,
    });
    useAccountStore.getState().markOffline('refresh_token=private-value');

    const view = render(<AccountBackupCard />);
    expect(view.getByText('オフライン')).toBeTruthy();
    expect(view.getByText('通信の回復後に自動で保存を再開します。')).toBeTruthy();
    expect(view.queryByText(/private-value/)).toBeNull();
  });

  test('uses the dedicated same-UID reauthentication action', () => {
    useAccountStore.getState().markConnected({
      userId: 'user-1',
      provider: 'google',
      email: 'owner@example.com',
    });
    useAccountStore.getState().markReauthRequired();

    const view = render(<AccountBackupCard />);
    fireEvent.press(view.getByLabelText('Googleで再ログイン'));

    expect(mockReauthenticate).toHaveBeenCalledWith('google', 'user-1');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test('does not invent a provider while deleting a guest account', () => {
    useAccountStore.getState().markDeletionPending();

    const view = render(<AccountBackupCard />);
    expect(view.getByText('アカウント削除を処理中')).toBeTruthy();
    expect(view.queryByText('Googleで保存中')).toBeNull();
  });
});
