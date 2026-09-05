# Recoto Travel and Calendar Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a personal travel tab with fast trip/itinerary entry and render approved thin, colored travel lines above calendar date numbers without obscuring existing schedules or special-date marks.

**Architecture:** Travel is a standalone owner-scoped Zustand domain backed by the cloud repository from the account plan. Pure date/lane functions split inclusive local-date trips into week segments. Calendar rendering consumes those precomputed segments while itinerary times use UTC plus explicit IANA time zones.

**Tech Stack:** Expo Router, React Native, Zustand, date-fns, Supabase, Jest, React Native Testing Library.

---

## Visual contract

- Palette: Ink `#1F2A44`, Recoto blue `#3B82F6`, mist `#EFF6FF`, paper `#FFFFFF`, line grey `#D9E2F2`, destructive `#DC2626`.
- Type: platform system sans; 22/800 screen titles, 16/800 section titles, 14/700 controls, 12/600 metadata.
- Layout: left-aligned list, quiet white cards, one floating add action. The distinctive element is the uninterrupted hairline travel route, not decorative card chrome.
- Calendar: two 3px lanes in the top 7px of each week row; date numbers begin below them; special-date/notes dots sit beside/below the number; existing mini/main bands stay pinned to the cell bottom.
- Motion: only user-triggered sheet transitions and press feedback; no decorative entrance animations.

## File map

- Create `types/travel.ts`, `constants/travel.ts`: domain contracts and safe presets.
- Create `utils/tripUtils.ts`, `utils/safeUrl.ts`: validation, sorting, week segmentation, lane packing.
- Create `utils/tripNotifications.ts`: contextual itinerary reminders and restore-time rescheduling.
- Create `store/tripStore.ts`: owner-scoped local CRUD and outbox enqueueing.
- Create `lib/account/tripMapper.ts`: cloud row conversion without device-only fields.
- Create `app/(tabs)/travel.tsx`: trip list screen.
- Create `components/travel/TripCard.tsx`, `TripFormSheet.tsx`, `TripDetailSheet.tsx`, `TripItemFormSheet.tsx`.
- Create `components/calendar/TripWeekOverlay.tsx`.
- Modify `app/(tabs)/_layout.tsx`, `components/calendar/MonthlyView.tsx`, `components/calendar/DayCell.tsx`, `constants/i18n.ts`, `types/index.ts`.
- Create `supabase/migrations/007_trips.sql` and update cloud repository mappings.

### Task 1: Define safe trip and itinerary data

- [ ] **Step 1: Write failing validation tests**

Create `tests/travel/tripUtils.test.ts` and `tests/travel/safeUrl.test.ts`:

```ts
import { validateTripDraft, sortTrips } from '../../utils/tripUtils';
import { normalizeSafeUrl } from '../../utils/safeUrl';

const fixtures = [
  { id: 'past', title: 'Past', startDate: '2026-08-01', endDate: '2026-08-02' },
  { id: 'next', title: 'Next', startDate: '2026-09-20', endDate: '2026-09-22' },
  { id: 'active', title: 'Active', startDate: '2026-09-01', endDate: '2026-09-10' },
];

test('requires a title and inclusive ordered local dates', () => {
  expect(validateTripDraft({ title: '', startDate: '2026-09-10', endDate: '2026-09-01' })).toEqual({
    valid: false,
    errors: { title: 'required', endDate: 'before-start' },
  });
});

test('sorts active then upcoming then past trips', () => {
  expect(sortTrips(fixtures, '2026-09-05').map((trip) => trip.id)).toEqual(['active', 'next', 'past']);
});

test.each([
  ['example.com', 'https://example.com/'],
  ['https://hotel.example/r/1', 'https://hotel.example/r/1'],
  ['javascript:alert(1)', null],
  ['file:///private/a', null],
])('normalizes %s safely', (input, expected) => {
  expect(normalizeSafeUrl(input)).toBe(expected);
});
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/travel/tripUtils.test.ts tests/travel/safeUrl.test.ts`.
Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement types and validators**

Use these domain contracts:

```ts
export type TripTransportIcon = 'none' | 'plane' | 'train' | 'car' | 'bus' | 'ship' | 'walk';
export type TripItemType = 'flight' | 'train' | 'hotel' | 'transport' | 'event' | 'meal' | 'memo';

export interface Trip {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  color: string;
  startIcon: TripTransportIcon;
  endIcon: TripTransportIcon;
  memo?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  deletedAt?: string;
}

export interface TripItem {
  id: string;
  tripId: string;
  type: TripItemType;
  localDate: string;
  allDay: boolean;
  startsAtUtc?: string;
  endsAtUtc?: string;
  departureTimezone?: string;
  arrivalTimezone?: string;
  departure?: string;
  arrival?: string;
  place?: string;
  reservationNumber?: string;
  url?: string;
  memo?: string;
  sortOrder: number;
  notificationId?: string;
}
```

Use only preset colors that pass contrast against white. `normalizeSafeUrl` accepts `http` and `https`, upgrades a bare hostname to `https`, and returns null for credentials, control characters, or every other scheme.

- [ ] **Step 4: Verify GREEN and commit**

Run `npm test -- tests/travel/tripUtils.test.ts tests/travel/safeUrl.test.ts && npm run typecheck`.
Commit as `feat: define travel domain and validation`.

### Task 2: Implement week segmentation and lane packing

- [ ] **Step 1: Add failing line-layout tests**

Extend `tripUtils.test.ts`:

```ts
import { buildTripWeekSegments, packTripLanes } from '../../utils/tripUtils';

const trip = (id: string, startDate: string, endDate: string) => ({
  id, title: id, startDate, endDate, color: '#3B82F6', startIcon: 'none' as const,
  endIcon: 'none' as const, createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z', revision: 1,
});
const septemberGrid = { gridStart: '2026-08-31', totalDays: 42, weekStartDay: 1 as const };

test('splits a multiweek inclusive trip into connected week segments', () => {
  expect(buildTripWeekSegments(trip('long', '2026-09-03', '2026-09-15'), septemberGrid)).toEqual([
    expect.objectContaining({ startColumn: 3, endColumn: 6, startsTrip: true, endsTrip: false }),
    expect.objectContaining({ startColumn: 0, endColumn: 6, startsTrip: false, endsTrip: false }),
    expect.objectContaining({ startColumn: 0, endColumn: 1, startsTrip: false, endsTrip: true }),
  ]);
});

test('uses two visible lanes and reports overflow', () => {
  const layout = packTripLanes([
    trip('a', '2026-09-07', '2026-09-10'),
    trip('b', '2026-09-08', '2026-09-11'),
    trip('c', '2026-09-09', '2026-09-12'),
  ], { weekStart: '2026-09-07', weekEnd: '2026-09-13' });
  expect(layout.visible).toHaveLength(2);
  expect(layout.overflowCount).toBe(1);
});
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/travel/tripUtils.test.ts`.
Expected: FAIL because segment functions are absent.

- [ ] **Step 3: Implement deterministic layout**

The segment start/end columns are based on the configured week start. Include both trip dates, clip to the 42-day calendar grid, sort overlaps by start date then duration then stable ID, assign the first available lane, and expose at most two lanes plus `overflowCount`.

- [ ] **Step 4: Verify GREEN and commit**

Run `npm test -- tests/travel/tripUtils.test.ts && npm run typecheck`.
Commit as `feat: compute calendar travel lanes`.

### Task 3: Build owner-scoped trip CRUD and cloud mapping

- [ ] **Step 1: Write failing store/mapper tests**

Create `tests/travel/tripStore.test.ts` and `tests/travel/tripCloudMapper.test.ts`. Assert create/update/delete, trip-item ordering, inclusive period validation, owner switching, outbox mutation IDs, and that `notificationId`, local URIs, and OAuth values never appear in cloud rows. Assert UTC values and IANA timezone strings round-trip unchanged.

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/travel/tripStore.test.ts tests/travel/tripCloudMapper.test.ts`.
Expected: FAIL until the store/mapper exist.

- [ ] **Step 3: Implement the store**

Expose:

```ts
interface TripState {
  trips: Trip[];
  items: TripItem[];
  addTrip(draft: TripDraft): Trip;
  updateTrip(id: string, draft: TripDraft): void;
  deleteTrip(id: string): void;
  addItem(tripId: string, draft: TripItemDraft): TripItem;
  updateItem(id: string, draft: TripItemDraft): void;
  deleteItem(id: string): void;
  replaceFromCloud(trips: Trip[], items: TripItem[]): void;
  clearForOwnerSwitch(): void;
}
```

Every mutation persists locally first and enqueues one durable outbox mutation. Deletion uses a tombstone; it does not immediately erase the cloud ID. Use crypto UUIDs rather than timestamps for IDs.

- [ ] **Step 4: Add the database schema**

`007_trips.sql` creates `trips` and `trip_items` with UUID owners, date constraints, timestamptz fields, timezone text, safe URL length constraints, revision/tombstone columns, FK indexes, and RLS policies using `(select auth.uid()) = user_id`. A trigger enforces that a trip item has the same owner as its parent trip.

- [ ] **Step 5: Verify GREEN and commit**

Run `npm test -- tests/travel/tripStore.test.ts tests/travel/tripCloudMapper.test.ts && npm run typecheck`.
Commit as `feat: persist and sync personal trips`.

### Task 4: Build the travel list, editor, and itinerary details

- [ ] **Step 1: Write failing screen tests**

Create `tests/travel/TravelScreen.test.tsx` and assert:

```ts
import { fireEvent, render } from '@testing-library/react-native';
import TravelScreen from '../../app/(tabs)/travel';
import { useTripStore } from '../../store/tripStore';

const tokyoTripFixture = () => ({
  id: 'trip-tokyo', title: '東京旅行', startDate: '2026-09-10', endDate: '2026-09-12',
  color: '#3B82F6', startIcon: 'plane' as const, endIcon: 'train' as const,
  createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z', revision: 1,
});

const openTripItemForm = (screen: ReturnType<typeof render>) => {
  fireEvent.press(screen.getByRole('button', { name: '旅行を追加' }));
  fireEvent.press(screen.getByRole('button', { name: '旅程を追加' }));
  fireEvent.press(screen.getByRole('button', { name: 'メモ' }));
};

beforeEach(() => useTripStore.setState({ trips: [], items: [] }));

test('empty state explains travel and opens the add sheet', () => {
  const screen = render(<TravelScreen />);
  expect(screen.getByText('旅行の予定をひとまとめに')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: '旅行を追加' }));
  expect(screen.getByRole('dialog', { name: '旅行を追加' })).toBeTruthy();
});

test('a saved trip appears with period color and endpoint icons', () => {
  useTripStore.setState({ trips: [tokyoTripFixture()], items: [] });
  const screen = render(<TravelScreen />);
  expect(screen.getByText('東京旅行')).toBeTruthy();
  expect(screen.getByLabelText('行き：飛行機')).toBeTruthy();
  expect(screen.getByLabelText('帰り：電車')).toBeTruthy();
});

test('flight and hotel forms reveal only relevant fields', () => {
  const screen = render(<TravelScreen />);
  fireEvent.press(screen.getByRole('button', { name: '旅行を追加' }));
  fireEvent.press(screen.getByRole('button', { name: '旅程を追加' }));
  fireEvent.press(screen.getByRole('button', { name: 'フライト' }));
  expect(screen.getByLabelText('出発地')).toBeTruthy();
  expect(screen.getByLabelText('到着地')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'ホテル' }));
  expect(screen.queryByLabelText('出発地')).toBeNull();
  expect(screen.getByLabelText('施設名')).toBeTruthy();
});

test('unsafe URL is rejected with an actionable message', () => {
  const screen = render(<TravelScreen />);
  openTripItemForm(screen);
  fireEvent.changeText(screen.getByLabelText('URL'), 'javascript:alert(1)');
  fireEvent.press(screen.getByRole('button', { name: '保存' }));
  expect(screen.getByText('http または https のURLを入力してください')).toBeTruthy();
});
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/travel/TravelScreen.test.tsx`.
Expected: FAIL because the screen/components do not exist.

- [ ] **Step 3: Implement list and sheets**

Add `travel` between `index` and `groups`. The list groups active/upcoming/past without separate decorative cards for every label. `TripFormSheet` initially shows title, dates, color, endpoint icons, and memo. `TripItemFormSheet` reveals only fields relevant to its selected type. Preserve form drafts across a recoverable validation error; dismissing asks only when fields changed.

- [ ] **Step 4: Add ja/en copy and accessibility**

Add `tab.travel` and every visible travel string to both dictionaries. Give icon-only buttons labels, maintain 44px targets, announce validation errors, and support Dynamic Type without fixed text-height clipping.

- [ ] **Step 5: Verify GREEN and browser UI**

Run `npm test -- tests/travel/TravelScreen.test.tsx && npm run typecheck`. In the browser, test empty, populated, editing, and narrow-width states.

- [ ] **Step 6: Commit**

Stage only the travel route/components/i18n tests and commit as `feat: add fast travel itinerary entry`.

### Task 5: Render the approved calendar line

- [ ] **Step 1: Write failing overlay tests**

Create `tests/travel/MonthlyTripOverlay.test.tsx` and render a week with full normal bands, a birthday, an anniversary, and three overlapping trips. Assert two lines, one `+1`, one tiny plane at the start, one tiny train at the end, and all existing marks remain present.

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/travel/MonthlyTripOverlay.test.tsx`.
Expected: FAIL because the overlay is absent.

- [ ] **Step 3: Implement week rows and overlay**

Render the 42 days as six seven-cell week rows. Place `TripWeekOverlay` absolutely across the week row using measured width; inset only true trip endpoints, let clipped week-boundary segments meet the row edges, and use 3px lines. Endpoint Ionicons are 6–7px, visually equivalent to the former dot. Reserve no more than 7px above date numbers.

- [ ] **Step 4: Preserve current calendar content**

Keep the date/special-date/notes marks in their own anchor and the mini/main schedule bands pinned to the bottom. Ensure the overlay has `pointerEvents="none"` so day taps and swipes remain unchanged.

- [ ] **Step 5: Verify GREEN, screenshot, and commit**

Run:

```bash
npm test -- tests/travel/MonthlyTripOverlay.test.tsx tests/travel/tripUtils.test.ts
npm run verify
```

Capture a browser screenshot with dense schedule bands, birthday/anniversary markers, and overlapping trips; compare it with the approved v7 prototype. Commit as `feat: show subtle travel routes on calendar`.

### Task 6: Add optional itinerary reminders

- [ ] **Step 1: Write failing reminder tests**

Create `tests/travel/tripNotifications.test.ts` with an injected notification gateway. Assert no permission request while creating an item with reminders off; enabling a reminder requests permission once in context; a denied permission leaves the item saved with reminders off; restored items receive new device notification IDs; and those IDs are never added to the cloud mapper.

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/travel/tripNotifications.test.ts`.
Expected: FAIL because the reminder coordinator is absent.

- [ ] **Step 3: Implement reminder coordination**

Expose `enableTripItemReminder(itemId, minutesBefore)`, `disableTripItemReminder(itemId)`, and `rescheduleTripRemindersAfterRestore()`. Ask for OS permission only from the enable action, schedule against `startsAtUtc`, cancel old device IDs on edits/deletes, and keep failures local/retryable without blocking itinerary save.

- [ ] **Step 4: Verify GREEN and commit**

Run `npm test -- tests/travel/tripNotifications.test.ts tests/travel/tripCloudMapper.test.ts && npm run typecheck`.
Commit as `feat: add optional itinerary reminders`.
