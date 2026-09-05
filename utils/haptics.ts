import * as ExpoHaptics from 'expo-haptics';

// Web環境でHapticsがエラーを投げるのを防ぐラッパー
export const Haptics = {
  impactAsync: (style?: ExpoHaptics.ImpactFeedbackStyle) =>
    ExpoHaptics.impactAsync(style).catch(() => {}),
  selectionAsync: () =>
    ExpoHaptics.selectionAsync().catch(() => {}),
  notificationAsync: (type?: ExpoHaptics.NotificationFeedbackType) =>
    ExpoHaptics.notificationAsync(type).catch(() => {}),
  ImpactFeedbackStyle: ExpoHaptics.ImpactFeedbackStyle,
  NotificationFeedbackType: ExpoHaptics.NotificationFeedbackType,
};
