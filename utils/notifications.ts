import * as Notifications from 'expo-notifications';
import { SchedulableTriggerInputTypes } from 'expo-notifications';
import { Platform } from 'react-native';

// 通知の表示設定（アプリ前面でも表示）
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** 通知権限をリクエスト（初回のみダイアログ表示） */
export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * 指定日・時間の5分前に通知をスケジュール（TIME_INTERVAL方式）
 * @returns { id, scheduledAt, error }
 */
export async function scheduleNotification(
  date: string,
  time: string,
  title: string,
  body: string
): Promise<{ id: string | null; scheduledAt?: Date; error?: string }> {
  if (Platform.OS === 'web') return { id: null };

  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);

  const eventTime = new Date(year, month - 1, day, hour, minute, 0);
  const triggerTime = new Date(eventTime.getTime() - 5 * 60 * 1000); // 5分前
  const now = new Date();
  const secondsUntil = Math.floor((triggerTime.getTime() - now.getTime()) / 1000);

  if (secondsUntil <= 0) {
    return {
      id: null,
      error: `通知時刻（${triggerTime.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}）が過去のためスキップ`,
    };
  }

  try {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: true,
      },
      trigger: {
        type: SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: secondsUntil,
      },
    });
    return { id, scheduledAt: triggerTime };
  } catch (e: any) {
    return { id: null, error: e?.message ?? '不明なエラー' };
  }
}

/** 通知をキャンセル */
export async function cancelNotification(notificationId: string): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await Notifications.cancelScheduledNotificationAsync(notificationId);
  } catch {}
}
