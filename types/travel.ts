export type TripTransportIcon =
  | 'none'
  | 'plane'
  | 'train'
  | 'car'
  | 'bus'
  | 'ship'
  | 'walk';

export type TripItemType =
  | 'flight'
  | 'train'
  | 'hotel'
  | 'transport'
  | 'event'
  | 'meal'
  | 'memo';

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
  /** Arrival calendar date in the destination timezone (legacy items may omit it). */
  arrivalLocalDate?: string;
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

export type TripDraft = Pick<
  Trip,
  'title' | 'startDate' | 'endDate' | 'color' | 'startIcon' | 'endIcon'
> & { memo?: string };

export type TripItemDraft = Omit<TripItem, 'id' | 'tripId' | 'notificationId'> & {
  notificationId?: string;
};

export type TripDraftError =
  | 'required'
  | 'invalid'
  | 'before-start'
  | 'unsupported';

export interface TripWeekSegment {
  trip: Trip;
  weekIndex: number;
  startColumn: number;
  endColumn: number;
  startsTrip: boolean;
  endsTrip: boolean;
  segmentStart: string;
  segmentEnd: string;
  lane?: number;
}
