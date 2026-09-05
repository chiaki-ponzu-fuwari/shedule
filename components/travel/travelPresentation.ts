import type { ComponentProps } from 'react';
import type { Ionicons } from '@expo/vector-icons';
import type { TripItemType, TripTransportIcon } from '../../types/travel';

export type IoniconName = ComponentProps<typeof Ionicons>['name'];

export const TRANSPORT_ICON_NAMES: Record<TripTransportIcon, IoniconName> = {
  none: 'remove',
  plane: 'airplane',
  train: 'train',
  car: 'car',
  bus: 'bus',
  ship: 'boat',
  walk: 'walk',
};

export const ITEM_ICON_NAMES: Record<TripItemType, IoniconName> = {
  flight: 'airplane-outline',
  train: 'train-outline',
  hotel: 'bed-outline',
  transport: 'car-outline',
  event: 'location-outline',
  meal: 'restaurant-outline',
  memo: 'document-text-outline',
};

export const transportLabelKey = (icon: TripTransportIcon) => `travel.transport.${icon}`;
export const itemTypeLabelKey = (type: TripItemType) => `travel.itemType.${type}`;
