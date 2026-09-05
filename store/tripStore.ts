import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { TRIP_ITEM_TYPES } from '../constants/travel';
import {
  createOwnerStateStorage,
  getPersonalOwnerStorage,
  type OwnerSwitchTarget,
} from '../lib/account/namespacedStorage';
import type { Trip, TripDraft, TripItem, TripItemDraft } from '../types/travel';
import { normalizeSafeUrl } from '../utils/safeUrl';
import { isValidLocalDate, validateTripDraft } from '../utils/tripUtils';
import { normalizeIanaTimeZone } from '../utils/tripTimezone';
import { assertActiveTripGraph } from '../lib/account/tripMapper';

export interface TripOwnerState {
  trips: Trip[];
  items: TripItem[];
}

interface TripState extends TripOwnerState {
  replaceState(state: TripOwnerState): void;
  replaceFromCloud(trips: Trip[], items: TripItem[]): void;
  clearForOwnerSwitch(): void;
  addTrip(draft: TripDraft): Trip;
  updateTrip(id: string, draft: TripDraft): void;
  deleteTrip(id: string): void;
  addItem(tripId: string, draft: TripItemDraft): TripItem;
  updateItem(id: string, draft: TripItemDraft): void;
  deleteItem(id: string): void;
}

const emptyTripOwnerState = (): TripOwnerState => ({ trips: [], items: [] });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function requireTripDraft(draft: TripDraft): TripDraft {
  const normalized: TripDraft = {
    ...draft,
    title: draft.title.trim(),
    ...(draft.memo?.trim() ? { memo: draft.memo.trim() } : { memo: undefined }),
  };
  const validation = validateTripDraft(normalized);
  if (!validation.valid) throw new Error(`Invalid trip: ${JSON.stringify(validation.errors)}`);
  return normalized;
}

function requireTripItemDraft(trip: Trip, draft: TripItemDraft): TripItemDraft {
  if (!TRIP_ITEM_TYPES.includes(draft.type)) throw new Error('Invalid trip item type');
  if (!isValidLocalDate(draft.localDate)) throw new Error('Invalid trip item date');
  if (draft.localDate < trip.startDate || draft.localDate > trip.endDate) {
    throw new Error('Trip item date is outside the trip');
  }
  if (draft.arrivalLocalDate !== undefined) {
    if (!isValidLocalDate(draft.arrivalLocalDate)) {
      throw new Error('Invalid trip item arrival date');
    }
    if (draft.arrivalLocalDate < trip.startDate || draft.arrivalLocalDate > trip.endDate) {
      throw new Error('Trip item arrival date is outside the trip');
    }
  }
  if (!Number.isSafeInteger(draft.sortOrder)) throw new Error('Invalid trip item order');

  const url = draft.url === undefined ? undefined : normalizeSafeUrl(draft.url);
  if (url === null) throw new Error('Invalid trip item URL');
  if (
    draft.startsAtUtc !== undefined
    && (!draft.startsAtUtc.endsWith('Z') || !Number.isFinite(Date.parse(draft.startsAtUtc)))
  ) throw new Error('Invalid trip item start time');
  if (
    draft.endsAtUtc !== undefined
    && (!draft.endsAtUtc.endsWith('Z') || !Number.isFinite(Date.parse(draft.endsAtUtc)))
  ) throw new Error('Invalid trip item end time');
  if (
    draft.startsAtUtc !== undefined
    && draft.endsAtUtc !== undefined
    && Date.parse(draft.endsAtUtc) < Date.parse(draft.startsAtUtc)
  ) throw new Error('Trip item end time is before its start time');

  const normalized: TripItemDraft = { ...draft };
  if (draft.departureTimezone !== undefined) {
    const timezone = normalizeIanaTimeZone(draft.departureTimezone);
    if (!timezone) throw new Error('Invalid trip item departure timezone');
    normalized.departureTimezone = timezone;
  }
  if (draft.arrivalTimezone !== undefined) {
    const timezone = normalizeIanaTimeZone(draft.arrivalTimezone);
    if (!timezone) throw new Error('Invalid trip item arrival timezone');
    normalized.arrivalTimezone = timezone;
  }
  if (draft.allDay) {
    normalized.startsAtUtc = undefined;
    normalized.endsAtUtc = undefined;
    normalized.arrivalLocalDate = undefined;
    normalized.departureTimezone = undefined;
    normalized.arrivalTimezone = undefined;
  }
  normalized.url = url;
  return normalized;
}

function sortItems(items: readonly TripItem[]): TripItem[] {
  return [...items].sort((left, right) =>
    left.localDate.localeCompare(right.localDate)
    || (left.startsAtUtc ?? '').localeCompare(right.startsAtUtc ?? '')
    || left.sortOrder - right.sortOrder
    || left.id.localeCompare(right.id));
}

const tripOwnerStorage = getPersonalOwnerStorage(AsyncStorage);

export const useTripStore = create<TripState>()(
  persist(
    (set, get) => ({
      ...emptyTripOwnerState(),

      replaceState: (state) => set(clone(state)),
      replaceFromCloud: (trips, items) => {
        assertActiveTripGraph(trips, items);
        set(clone({ trips, items: sortItems(items) }));
      },
      clearForOwnerSwitch: () => set(emptyTripOwnerState()),

      addTrip: (input) => {
        const draft = requireTripDraft(input);
        const timestamp = new Date().toISOString();
        const trip: Trip = {
          ...draft,
          id: Crypto.randomUUID(),
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 1,
        };
        set((state) => ({ trips: [...state.trips, trip] }));
        return clone(trip);
      },

      updateTrip: (id, input) => {
        const draft = requireTripDraft(input);
        const current = get().trips.find((trip) => trip.id === id);
        if (!current) throw new Error(`Trip not found: ${id}`);
        if (get().items.some((item) => item.tripId === id && (
          item.localDate < draft.startDate
          || item.localDate > draft.endDate
          || Boolean(item.arrivalLocalDate && (
            item.arrivalLocalDate < draft.startDate
            || item.arrivalLocalDate > draft.endDate
          ))
        ))) {
          throw new Error('An itinerary item is outside the new trip period');
        }
        set((state) => ({
          trips: state.trips.map((trip) => trip.id === id
            ? {
                ...trip,
                ...draft,
                updatedAt: new Date().toISOString(),
                revision: trip.revision + 1,
              }
            : trip),
        }));
      },

      deleteTrip: (id) => {
        if (!get().trips.some((trip) => trip.id === id)) return;
        set((state) => ({
          trips: state.trips.filter((trip) => trip.id !== id),
          items: state.items.filter((item) => item.tripId !== id),
        }));
      },

      addItem: (tripId, input) => {
        const trip = get().trips.find((candidate) => candidate.id === tripId);
        if (!trip) throw new Error(`Trip not found: ${tripId}`);
        const draft = requireTripItemDraft(trip, input);
        const item: TripItem = { ...draft, id: Crypto.randomUUID(), tripId };
        set((state) => ({ items: sortItems([...state.items, item]) }));
        return clone(item);
      },

      updateItem: (id, input) => {
        const current = get().items.find((item) => item.id === id);
        if (!current) throw new Error(`Trip item not found: ${id}`);
        const trip = get().trips.find((candidate) => candidate.id === current.tripId);
        if (!trip) throw new Error(`Trip not found: ${current.tripId}`);
        const draft = requireTripItemDraft(trip, input);
        set((state) => ({
          items: sortItems(state.items.map((item) => item.id === id
            ? { ...draft, id, tripId: current.tripId }
            : item)),
        }));
      },

      deleteItem: (id) => set((state) => ({
        items: state.items.filter((item) => item.id !== id),
      })),
    }),
    {
      name: 'trips',
      storage: createJSONStorage(() => createOwnerStateStorage(tripOwnerStorage)),
      partialize: (state) => ({ trips: state.trips, items: state.items }),
    },
  ),
);

export function createTripOwnerSwitchTarget(): OwnerSwitchTarget<TripOwnerState> {
  return {
    snapshot: () => clone({
      trips: useTripStore.getState().trips,
      items: useTripStore.getState().items,
    }),
    clearForOwnerSwitch: () => useTripStore.getState().clearForOwnerSwitch(),
    replaceState: (state) => useTripStore.getState().replaceState(state),
    rehydrate: () => useTripStore.persist.rehydrate(),
    hasHydrated: () => useTripStore.persist.hasHydrated(),
  };
}
