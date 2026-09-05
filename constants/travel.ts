import type { TripItemType, TripTransportIcon } from '../types/travel';

export const TRIP_COLOR_PRESETS = [
  '#2563EB',
  '#7C3AED',
  '#DB2777',
  '#DC2626',
  '#C2410C',
  '#047857',
  '#0F766E',
] as const;

export const TRIP_TRANSPORT_ICONS: readonly TripTransportIcon[] = [
  'none',
  'plane',
  'train',
  'car',
  'bus',
  'ship',
  'walk',
];

export const TRIP_ITEM_TYPES: readonly TripItemType[] = [
  'flight',
  'train',
  'hotel',
  'transport',
  'event',
  'meal',
  'memo',
];
