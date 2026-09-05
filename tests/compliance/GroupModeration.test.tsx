import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { GroupMemberActions } from '../../components/groups/MemberActionsSheet';
import { ReportSheet } from '../../components/groups/ReportSheet';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const member = { id: 'member-2', name: 'Member 2', color: '#3B82F6' };

describe('group moderation controls', () => {
  test('only an owner sees remove and prevent rejoin', () => {
    const owner = render(
      <GroupMemberActions visible role="owner" member={member} onClose={jest.fn()} />
    );
    expect(owner.getByLabelText('除名して再参加を防ぐ')).toBeTruthy();
    owner.unmount();

    const regular = render(
      <GroupMemberActions visible role="member" member={member} onClose={jest.fn()} />
    );
    expect(regular.queryByLabelText('除名して再参加を防ぐ')).toBeNull();
  });

  test('a member can block another member', () => {
    const onBlock = jest.fn();
    const screen = render(
      <GroupMemberActions
        visible
        role="member"
        member={member}
        onClose={jest.fn()}
        onBlock={onBlock}
      />
    );

    fireEvent.press(screen.getByLabelText('ブロック'));
    expect(onBlock).toHaveBeenCalledWith('member-2');
  });

  test('self actions never offer report, block, or removal', () => {
    const screen = render(
      <GroupMemberActions visible role="self" member={member} onClose={jest.fn()} />
    );

    expect(screen.queryByLabelText('通報')).toBeNull();
    expect(screen.queryByLabelText('ブロック')).toBeNull();
    expect(screen.queryByLabelText('除名して再参加を防ぐ')).toBeNull();
  });

  test('report requires a reason, caps details, and exposes public safety contact', async () => {
    const onSubmit = jest.fn();
    const screen = render(
      <ReportSheet
        visible
        member={member}
        onClose={jest.fn()}
        onSubmit={onSubmit}
      />
    );

    expect(screen.getByText('herac.7.app@gmail.com')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('スパム・詐欺'));
    fireEvent.changeText(screen.getByLabelText('通報の詳細（任意）'), 'x'.repeat(550));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('通報する'));
    });

    expect(onSubmit).toHaveBeenCalledWith({ reason: 'spam_fraud', detail: 'x'.repeat(500) });
  });

  test('does not create duplicate reports while a submission is pending', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const onSubmit = jest.fn(() => pending);
    const screen = render(
      <ReportSheet visible member={member} onClose={jest.fn()} onSubmit={onSubmit} />
    );

    fireEvent.press(screen.getByLabelText('スパム・詐欺'));
    fireEvent.press(screen.getByLabelText('通報する'));
    fireEvent.press(screen.getByLabelText('通報する'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('通報する').props.accessibilityState).toMatchObject({
      disabled: true,
      busy: true,
    });

    await act(async () => {
      resolve();
      await pending;
    });
  });
});
