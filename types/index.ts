// Privacy level: 0=private, 1=main stamp only, 2=main+mini stamps, 3=full (incl notes)
export type PrivacyLevel = 0 | 1 | 2 | 3;

export interface Stamp {
  id: string;
  text: string;
  bgColor: string;
  textColor: string;
  isDefault?: boolean;
  isMain?: boolean;    // true = main stamp, false = mini stamp, undefined = both
  isEnabled?: boolean; // false = hidden from picker (default = true/undefined)
  isImageStamp?: boolean; // true = 画像スタンプ
  imageUri?: string;      // 画像スタンプのURI
}

export interface MiniStamps {
  left?: string;   // stamp ID
  right?: string;  // stamp ID
}

export interface NoteItem {
  id: string;
  text: string;
  time?: string;               // "HH:MM" 開始時間
  endTime?: string;            // "HH:MM" 終了時間
  notificationEnabled?: boolean;
  notificationId?: string;
  fromTimeSlotId?: string;     // タイムスロットから反映された場合のID
  color?: string;              // タイムスケジュール表示色
  url?: string;                // ZOOMリンク・GoogleMAPなど外部URL
  fromGoogleId?: string;       // GoogleカレンダーイベントID（Googleから同期した場合）
  /** 最後にGoogleへ送った内容の指紋（無駄な update API を省略） */
  googlePushFingerprint?: string;
  syncToGoogle?: boolean;      // このアイテムをGoogleに同期するか
  googleSyncDirection?: 'none' | 'toGoogle' | 'fromGoogle' | 'both'; // 同期方向
}

export interface DayEntry {
  date: string;          // YYYY-MM-DD
  mainStampId?: string;
  miniStamps: MiniStamps;
  notes?: string;
  noteItems?: NoteItem[];        // 複数メモ・予定リスト
  privacyLevel: PrivacyLevel;
  startTime?: string;            // "HH:MM"
  endTime?: string;              // "HH:MM"
  notificationEnabled?: boolean;
  notificationId?: string;       // スケジュール済み通知ID
  imageUri?: string;             // photo URI for image stamp
  timeSlots?: TimeSlot[];        // timeline events
  diary?: string;                // 日記テキスト
  diaryPhotos?: string[];        // 写真URI（最大2枚）
  diaryConfirmed?: boolean;      // 日記確定フラグ
  dailyGoal?: string;            // 本日の目標
}

export interface TimeSlot {
  id: string;
  startTime: string; // "HH:MM"
  endTime: string;   // "HH:MM"
  title: string;
  color: string;
  url?: string; // 外部URL（任意）
  notificationEnabled?: boolean;
  notificationId?: string;
  reflectToMonthly?: boolean;  // マンスリーカレンダーに反映するか
}

export interface RecurringSchedule {
  id: string;
  name: string;
  stampId: string;
  stampPosition: 'main' | 'mini-left' | 'mini-right';
  daysOfWeek: number[];  // 0=Sun, 1=Mon, ..., 6=Sat
  appliedMonths?: string[]; // 適用済み月 "YYYY-MM" 形式
}

export interface SpecialDate {
  id: string;
  name: string;
  month: number;   // 1-12
  day: number;     // 1-31
  color: string;
  type: 'birthday' | 'anniversary' | 'other';
  emoji?: string;
}

export interface GroupMember {
  id: string;
  name: string;
  color: string;
  isOwner?: boolean;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  emoji: string;
  iconUri?: string; // 画像アイコン（端末ローカルURI）
  inviteCode: string;
  members: GroupMember[];
  sharedMemo?: string;
  createdAt: string;
}

export interface GroupSharingSettings {
  shareMain: boolean;
  shareMini: boolean;
  shareNotes: boolean;
  shareTimeSchedule: boolean;
}

export interface SharedEntry {
  userId: string;
  userName: string;
  userColor: string;
  date: string;
  mainStampText?: string;
  mainStampBg?: string;
  mainStampTextColor?: string;
  miniLeftText?: string;
  miniLeftBg?: string;
  miniRightText?: string;
  miniRightBg?: string;
  notes?: string;
  timeSlots?: TimeSlot[];
}

export interface SyncEntryData {
  date: string;
  mainStampText?: string;
  mainStampBg?: string;
  mainStampTextColor?: string;
  miniLeftText?: string;
  miniLeftBg?: string;
  miniRightText?: string;
  miniRightBg?: string;
  notes?: string;
  timeSlots?: TimeSlot[];
}

export type CalendarView = 'monthly' | 'weekly' | 'daily';

export interface DayInfo {
  date: Date;
  dateString: string;  // YYYY-MM-DD
  isToday: boolean;
  isCurrentMonth: boolean;
  isSunday: boolean;
  isSaturday: boolean;
  specialDate?: SpecialDate;
}
