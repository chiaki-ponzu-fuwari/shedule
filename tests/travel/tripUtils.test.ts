import type { Trip } from '../../types/travel';
import {
  buildTripWeekSegments,
  packTripLanes,
  sortTrips,
  validateTripDraft,
} from '../../utils/tripUtils';

function trip(id: string, startDate: string, endDate: string): Trip {
  return {
    id,
    title: id,
    startDate,
    endDate,
    color: '#2563EB',
    startIcon: 'none',
    endIcon: 'none',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    revision: 1,
  };
}

describe('travel dates and ordering', () => {
  test('requires a title and inclusive ordered local dates', () => {
    expect(validateTripDraft({
      title: '   ',
      startDate: '2026-09-10',
      endDate: '2026-09-01',
      color: '#2563EB',
      startIcon: 'none',
      endIcon: 'none',
    })).toEqual({
      valid: false,
      errors: { title: 'required', endDate: 'before-start' },
    });
  });

  test('rejects impossible calendar dates rather than normalizing them', () => {
    expect(validateTripDraft({
      title: '沖縄',
      startDate: '2026-02-30',
      endDate: '2026-03-02',
      color: '#2563EB',
      startIcon: 'plane',
      endIcon: 'plane',
    })).toEqual({ valid: false, errors: { startDate: 'invalid' } });
  });

  test('sorts active then upcoming then past trips', () => {
    const trips = [
      trip('past', '2026-08-01', '2026-08-02'),
      trip('next', '2026-09-20', '2026-09-22'),
      trip('active', '2026-09-01', '2026-09-10'),
    ];
    expect(sortTrips(trips, '2026-09-05').map((item) => item.id))
      .toEqual(['active', 'next', 'past']);
  });
});

describe('monthly travel line layout', () => {
  test('splits an inclusive multiweek trip into connected week segments', () => {
    expect(buildTripWeekSegments(trip('long', '2026-09-03', '2026-09-15'), {
      gridStart: '2026-08-31',
      totalDays: 42,
    })).toEqual([
      expect.objectContaining({
        weekIndex: 0,
        startColumn: 3,
        endColumn: 6,
        startsTrip: true,
        endsTrip: false,
      }),
      expect.objectContaining({
        weekIndex: 1,
        startColumn: 0,
        endColumn: 6,
        startsTrip: false,
        endsTrip: false,
      }),
      expect.objectContaining({
        weekIndex: 2,
        startColumn: 0,
        endColumn: 1,
        startsTrip: false,
        endsTrip: true,
      }),
    ]);
  });

  test('clips endpoints outside the visible grid without showing false endpoint icons', () => {
    expect(buildTripWeekSegments(trip('clipped', '2026-08-20', '2026-10-20'), {
      gridStart: '2026-08-31',
      totalDays: 42,
    })[0]).toEqual(expect.objectContaining({
      startColumn: 0,
      startsTrip: false,
    }));
  });

  test('uses two visible lanes and reports unique overflow trips', () => {
    const layout = packTripLanes([
      trip('a', '2026-09-07', '2026-09-10'),
      trip('b', '2026-09-08', '2026-09-11'),
      trip('c', '2026-09-09', '2026-09-12'),
    ], { weekStart: '2026-09-07', weekEnd: '2026-09-13' });

    expect(layout.visible).toHaveLength(2);
    expect(layout.visible.map((segment) => segment.lane)).toEqual([0, 1]);
    expect(layout.overflowCount).toBe(1);
  });
});
