import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Trip, TripTransportIcon } from '../../types/travel';
import { packTripLanes } from '../../utils/tripUtils';
import { TRANSPORT_ICON_NAMES } from '../travel/travelPresentation';

interface Props {
  trips: readonly Trip[];
  weekStart: string;
  weekEnd: string;
  width: number;
}

const LANE_HEIGHT = 3;
const MARK_SIZE = 5;

function EndpointMark({
  tripId,
  side,
  icon,
  color,
  center,
  top,
}: {
  tripId: string;
  side: 'start' | 'end';
  icon: TripTransportIcon;
  color: string;
  center: number;
  top: number;
}) {
  const testID = `travel-${side}-${tripId}-${icon}`;
  if (icon === 'none') {
    return (
      <View
        testID={testID}
        style={[styles.dot, { backgroundColor: color, left: center - 2, top: top + 0.5 }]}
      />
    );
  }
  return (
    <View testID={testID} style={[styles.mark, { left: center - MARK_SIZE / 2, top }]}>
      <Ionicons name={TRANSPORT_ICON_NAMES[icon]} size={MARK_SIZE} color={color} />
    </View>
  );
}

export function TripWeekOverlay({ trips, weekStart, weekEnd, width }: Props) {
  const layout = packTripLanes(trips, { weekStart, weekEnd });
  const columnWidth = width / 7;

  return (
    <View pointerEvents="none" accessible={false} style={[styles.overlay, { width }]}>
      {layout.visible.map((segment) => {
        const laneTop = (segment.lane ?? 0) * LANE_HEIGHT;
        const start = segment.startsTrip
          ? (segment.startColumn + 0.5) * columnWidth
          : segment.startColumn * columnWidth;
        const end = segment.endsTrip
          ? (segment.endColumn + 0.5) * columnWidth
          : (segment.endColumn + 1) * columnWidth;
        const coincidentEndpoints = segment.startsTrip && segment.endsTrip && start === end;
        const visibleStart = coincidentEndpoints ? start - MARK_SIZE / 2 : start;
        const visibleEnd = coincidentEndpoints ? end + MARK_SIZE / 2 : end;
        return (
          <React.Fragment key={segment.trip.id}>
            <View
              testID={`travel-line-${segment.trip.id}`}
              style={[
                styles.line,
                {
                  top: laneTop + 2,
                  left: visibleStart,
                  width: Math.max(4, visibleEnd - visibleStart),
                  backgroundColor: segment.trip.color,
                },
              ]}
            />
            {segment.startsTrip ? (
              <EndpointMark
                tripId={segment.trip.id}
                side="start"
                icon={segment.trip.startIcon}
                color={segment.trip.color}
                center={visibleStart}
                top={laneTop}
              />
            ) : null}
            {segment.endsTrip ? (
              <EndpointMark
                tripId={segment.trip.id}
                side="end"
                icon={segment.trip.endIcon}
                color={segment.trip.color}
                center={visibleEnd}
                top={laneTop}
              />
            ) : null}
          </React.Fragment>
        );
      })}
      {layout.overflowCount > 0 ? (
        <Text testID="travel-overflow" style={styles.overflow}>+{layout.overflowCount}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 1,
    left: 0,
    height: 8,
    zIndex: 10,
    overflow: 'hidden',
  },
  line: { position: 'absolute', height: 2, borderRadius: 1, opacity: 0.9 },
  mark: {
    position: 'absolute',
    width: MARK_SIZE,
    height: MARK_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: MARK_SIZE / 2,
  },
  dot: { position: 'absolute', width: 4, height: 4, borderRadius: 2 },
  overflow: {
    position: 'absolute',
    top: 0,
    right: 2,
    paddingHorizontal: 2,
    color: '#475569',
    backgroundColor: 'rgba(255,255,255,0.92)',
    fontSize: 7,
    fontWeight: '800',
    lineHeight: 8,
  },
});
