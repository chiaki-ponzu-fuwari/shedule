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

export interface DayEntry {
  date: string;          // YYYY-MM-DD
  mainStampId?: string;
  miniStamps: MiniStamps;
  notes?: string;
  privacyLevel: PrivacyLevel;
  startTime?: string;            // "HH:MM"
  endTime?: string;              // "HH:MM"
  notificationEnabled?: boolean;
  imageUri?: string;             // photo URI for image stamp
  timeSlots?: TimeSlot[];        // timeline events
  diary?: string;                // 日記テキスト
  diaryPhotos?: string[];        // 写真URI（最大2枚）
}

export interface TimeSlot {
  id: string;
  startTime: string; // "HH:MM"
  endTime: string;   // "HH:MM"
  title: string;
  color: string;
}

export interface RecurringSchedule {
  id: string;
  name: string;
  stampId: string;
  stampPosition: 'main' | 'mini-left' | 'mini-right';
  daysOfWeek: number[];  // 0=Sun, 1=Mon, ..., 6=Sat
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
  inviteCode: string;
  members: GroupMember[];
  sharedMemo?: string;
  createdAt: string;
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
