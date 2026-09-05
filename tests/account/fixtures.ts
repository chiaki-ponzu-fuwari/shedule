import {
  CURRENT_PERSONAL_SCHEMA_VERSION,
  type OutboxMutation,
  type PersonalSnapshot,
} from '../../types/account';

export const emptyPersonalSnapshot = (): PersonalSnapshot => ({
  entries: {},
  specialDates: [],
  preferences: {},
  stamps: [],
  trips: [],
  tripItems: [],
});

export const fullPersonalSnapshot = (): PersonalSnapshot => ({
  entries: {
    '2026-09-05': {
      date: '2026-09-05',
      miniStamps: {},
      privacyLevel: 2,
      notes: 'saved',
    },
  },
  specialDates: [],
  preferences: { weekStartDay: 1 },
  stamps: [],
  trips: [],
  tripItems: [],
});

export const mutationFixture = (
  overrides: Partial<OutboxMutation> = {},
): OutboxMutation => ({
  mutationId: 'm-default',
  ownerId: 'u1',
  entity: 'calendar-entry',
  entityId: 'd1',
  operation: 'upsert',
  payload: { notes: 'saved' },
  baseRevision: null,
  createdAt: '2026-09-05T00:00:00Z',
  attempts: 0,
  schemaVersion: CURRENT_PERSONAL_SCHEMA_VERSION,
  ...overrides,
});
