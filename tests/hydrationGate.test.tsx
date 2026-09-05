type HydrationState = {
  status: 'hydrating' | 'ready' | 'failed';
  retry: jest.Mock;
};

describe('root hydration gate', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  function loadLayout(initialState: HydrationState) {
    let hydrationState = initialState;
    const useSupabaseAuth = jest.fn();
    const useAccountBootstrap = jest.fn(() => ({ status: 'ready', retry: jest.fn() }));
    const useGoogleCalendarAutoSync = jest.fn();
    const useAccountCloudSync = jest.fn();

    jest.resetModules();
    const persisted = new Map<string, string>();
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      __esModule: true,
      default: {
        getItem: jest.fn(async (key: string) => persisted.get(key) ?? null),
        setItem: jest.fn(async (key: string, value: string) => { persisted.set(key, value); }),
        removeItem: jest.fn(async (key: string) => { persisted.delete(key); }),
      },
    }));
    jest.doMock('../hooks/useLocalStoresHydrated', () => ({
      useLocalStoresHydration: () => hydrationState,
    }));
    jest.doMock('../hooks/useSupabaseAuth', () => ({ useSupabaseAuth }));
    jest.doMock('../hooks/useAccountBootstrap', () => ({ useAccountBootstrap }));
    jest.doMock('../hooks/useGoogleCalendarAutoSync', () => ({
      useGoogleCalendarAutoSync,
    }));
    jest.doMock('../hooks/useAccountCloudSync', () => ({ useAccountCloudSync }));
    jest.doMock('expo-router', () => {
      const React = require('react') as typeof import('react');
      const { View } = require('react-native') as typeof import('react-native');
      const Stack = ({ children }: { children?: React.ReactNode }) =>
        React.createElement(View, null, children);
      Stack.Screen = () => null;
      return { Stack, usePathname: () => '/' };
    });
    jest.doMock('react-native-gesture-handler', () => {
      const { View } = require('react-native') as typeof import('react-native');
      return { GestureHandlerRootView: View };
    });
    jest.doMock('expo-status-bar', () => ({ StatusBar: () => null }));

    const React = require('react') as typeof import('react');
    const testing = require('@testing-library/react-native/pure') as typeof import('@testing-library/react-native/pure');
    const layout = require('../app/_layout') as {
      HydrationGate?: React.ComponentType;
    };

    return {
      React,
      testing,
      layout,
      useSupabaseAuth,
      useGoogleCalendarAutoSync,
      setHydrationState(nextState: HydrationState) {
        hydrationState = nextState;
      },
    };
  }

  test('does not mount cloud observers until every local store is ready', () => {
    const retry = jest.fn();
    const loaded = loadLayout({ status: 'hydrating', retry });
    expect(loaded.layout.HydrationGate).toEqual(expect.any(Function));

    const { rerender, unmount } = loaded.testing.render(
      loaded.React.createElement(loaded.layout.HydrationGate!)
    );

    expect(loaded.useSupabaseAuth).not.toHaveBeenCalled();
    expect(loaded.useGoogleCalendarAutoSync).not.toHaveBeenCalled();

    loaded.setHydrationState({ status: 'ready', retry });
    rerender(loaded.React.createElement(loaded.layout.HydrationGate!));

    expect(loaded.useSupabaseAuth).toHaveBeenCalledTimes(1);
    expect(loaded.useGoogleCalendarAutoSync).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('keeps the application unmounted and offers retry after hydration fails', () => {
    const retry = jest.fn();
    const loaded = loadLayout({ status: 'failed', retry });
    expect(loaded.layout.HydrationGate).toEqual(expect.any(Function));

    const rendered = loaded.testing.render(
      loaded.React.createElement(loaded.layout.HydrationGate!)
    );

    loaded.testing.fireEvent.press(rendered.getByText('再試行'));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(loaded.useSupabaseAuth).not.toHaveBeenCalled();
    expect(loaded.useGoogleCalendarAutoSync).not.toHaveBeenCalled();
    rendered.unmount();
  });

  test('localizes the recovery screen without exposing internal storage errors', () => {
    const retry = jest.fn();
    const loaded = loadLayout({ status: 'failed', retry });
    const { useLocaleStore } = require('../store/localeStore') as typeof import('../store/localeStore');
    useLocaleStore.setState({ locale: 'en' });

    const rendered = loaded.testing.render(
      loaded.React.createElement(loaded.layout.HydrationGate!),
    );

    expect(rendered.getByText('Saved data could not be opened')).toBeTruthy();
    loaded.testing.fireEvent.press(rendered.getByText('Retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });

  test('a real storage read failure starts no persisted writes, auth observer, or auto sync', async () => {
    const storage = {
      getItem: jest.fn(async () => {
        throw new Error('storage unavailable');
      }),
      setItem: jest.fn(async () => undefined),
      removeItem: jest.fn(async () => undefined),
    };
    const useSupabaseAuth = jest.fn();
    const useAccountBootstrap = jest.fn(() => ({ status: 'ready', retry: jest.fn() }));
    const useGoogleCalendarAutoSync = jest.fn();
    const useAccountCloudSync = jest.fn();

    jest.resetModules();
    jest.dontMock('../hooks/useLocalStoresHydrated');
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      __esModule: true,
      default: storage,
    }));
    jest.doMock('../hooks/useSupabaseAuth', () => ({ useSupabaseAuth }));
    jest.doMock('../hooks/useAccountBootstrap', () => ({ useAccountBootstrap }));
    jest.doMock('../hooks/useGoogleCalendarAutoSync', () => ({
      useGoogleCalendarAutoSync,
    }));
    jest.doMock('../hooks/useAccountCloudSync', () => ({ useAccountCloudSync }));
    jest.doMock('expo-router', () => {
      const React = require('react') as typeof import('react');
      const { View } = require('react-native') as typeof import('react-native');
      const Stack = ({ children }: { children?: React.ReactNode }) =>
        React.createElement(View, null, children);
      Stack.Screen = () => null;
      return { Stack, usePathname: () => '/' };
    });
    jest.doMock('react-native-gesture-handler', () => {
      const { View } = require('react-native') as typeof import('react-native');
      return { GestureHandlerRootView: View };
    });
    jest.doMock('expo-status-bar', () => ({ StatusBar: () => null }));

    const React = require('react') as typeof import('react');
    const testing =
      require('@testing-library/react-native/pure') as typeof import('@testing-library/react-native/pure');
    const { HydrationGate } =
      require('../app/_layout') as typeof import('../app/_layout');
    const rendered = testing.render(React.createElement(HydrationGate));

    await testing.waitFor(() => {
      expect(rendered.getByText('保存したデータを読み込めませんでした')).toBeTruthy();
    });
    expect(storage.getItem).toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(useSupabaseAuth).not.toHaveBeenCalled();
    expect(useGoogleCalendarAutoSync).not.toHaveBeenCalled();
    rendered.unmount();
  });
});
