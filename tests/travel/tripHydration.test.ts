jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-crypto', () => ({ randomUUID: () => 'hydration-install' }));

import { persistedLocalStores } from '../../hooks/useLocalStoresHydrated';
import { useTripStore } from '../../store/tripStore';

test('travel storage is hydrated before owner-scoped UI is mounted', () => {
  expect(persistedLocalStores).toContain(useTripStore);
});
