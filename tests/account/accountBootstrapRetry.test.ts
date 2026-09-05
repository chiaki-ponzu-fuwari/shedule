import {
  createAccountBootstrapRetryScheduler,
} from '../../lib/account/accountBootstrapRetry';

describe('account bootstrap retry scheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('retries a safe temporary failure while preserving exponential attempts', () => {
    const retry = jest.fn();
    const scheduler = createAccountBootstrapRetryScheduler({
      canRetry: () => true,
      retry,
      delaysMs: [1_000, 5_000],
    });

    scheduler.update({ status: 'safe-failure', ownerId: 'user-a', message: 'offline' });
    jest.advanceTimersByTime(999);
    expect(retry).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);

    scheduler.update({ status: 'bootstrapping' });
    scheduler.update({ status: 'safe-failure', ownerId: 'user-a', message: 'offline' });
    jest.advanceTimersByTime(4_999);
    expect(retry).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  test('cancels pending work when the account is no longer retryable or the binding stops', () => {
    let allowed = true;
    const retry = jest.fn();
    const scheduler = createAccountBootstrapRetryScheduler({
      canRetry: () => allowed,
      retry,
      delaysMs: [1_000],
    });

    scheduler.update({ status: 'safe-failure', ownerId: 'user-a', message: 'offline' });
    allowed = false;
    jest.advanceTimersByTime(1_000);
    expect(retry).not.toHaveBeenCalled();

    allowed = true;
    scheduler.update({ status: 'safe-failure', ownerId: 'user-a', message: 'offline' });
    scheduler.stop();
    jest.advanceTimersByTime(1_000);
    expect(retry).not.toHaveBeenCalled();
  });

  test('resets the backoff only after bootstrap becomes ready', () => {
    const retry = jest.fn();
    const scheduler = createAccountBootstrapRetryScheduler({
      canRetry: () => true,
      retry,
      delaysMs: [1_000, 5_000],
    });

    scheduler.update({ status: 'safe-failure', ownerId: 'user-a', message: 'offline' });
    jest.advanceTimersByTime(1_000);
    scheduler.update({ status: 'ready', ownerId: 'user-a' });
    scheduler.update({ status: 'safe-failure', ownerId: 'user-a', message: 'offline' });
    jest.advanceTimersByTime(1_000);

    expect(retry).toHaveBeenCalledTimes(2);
  });
});
