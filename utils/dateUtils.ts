import { DayInfo, SpecialDate } from '../types';

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isToday(date: Date): boolean {
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

export function isSameDay(a: Date, b: Date): boolean {
  return formatDate(a) === formatDate(b);
}

export function getMonthLabel(year: number, month: number): string {
  return `${year}年${month + 1}月`;
}

export function addMonths(date: Date, n: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  d.setDate(1);
  return d;
}

export function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Returns all day cells for a monthly view (including padding from prev/next month) */
export function getMonthDays(year: number, month: number, specialDates: SpecialDate[] = []): DayInfo[] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);

  // 月曜始まり: 最初の月曜日から開始
  const startOffset = (firstDay.getDay() + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  const start = new Date(year, month, 1 - startOffset);

  // 日曜日で終わる
  const endOffset = (7 - lastDay.getDay()) % 7;
  const end = new Date(year, month + 1, endOffset);

  const days: DayInfo[] = [];
  let cur = new Date(start);

  while (cur <= end) {
    const dateString = formatDate(cur);
    const curMonth = cur.getMonth();
    const curDay = cur.getDate();

    const special = specialDates.find(
      (s) => s.month === curMonth + 1 && s.day === curDay
    );

    days.push({
      date: new Date(cur),
      dateString,
      isToday: isToday(cur),
      isCurrentMonth: curMonth === month,
      isSunday: cur.getDay() === 0,
      isSaturday: cur.getDay() === 6,
      specialDate: special,
    });

    cur = addDays(cur, 1);
  }

  return days;
}

/** Returns 7 days starting from the Monday of the week containing `date` */
export function getWeekDays(date: Date, specialDates: SpecialDate[] = []): DayInfo[] {
  const day = date.getDay(); // 0=Sun
  const monday = addDays(date, -((day + 6) % 7)); // start from Monday
  const days: DayInfo[] = [];

  for (let i = 0; i < 7; i++) {
    const cur = addDays(monday, i);
    const dateString = formatDate(cur);
    const special = specialDates.find(
      (s) => s.month === cur.getMonth() + 1 && s.day === cur.getDate()
    );
    days.push({
      date: cur,
      dateString,
      isToday: isToday(cur),
      isCurrentMonth: true,
      isSunday: cur.getDay() === 0,
      isSaturday: cur.getDay() === 6,
      specialDate: special,
    });
  }

  return days;
}

export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
export const WEEKDAY_LABELS_MON_FIRST = ['月', '火', '水', '木', '金', '土', '日'];
export const WEEKDAY_LABELS_LONG = ['日曜', '月曜', '火曜', '水曜', '木曜', '金曜', '土曜'];

export function formatMonthDay(dateStr: string): string {
  const d = parseDate(dateStr);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatFullDate(dateStr: string): string {
  const d = parseDate(dateStr);
  const w = WEEKDAY_LABELS[d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${w}）`;
}

/** Generate all YYYY-MM-DD strings in a given year-month that match daysOfWeek */
export function getDatesForWeekdays(
  year: number,
  month: number,
  daysOfWeek: number[]
): string[] {
  const result: string[] = [];
  const lastDay = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= lastDay; d++) {
    const date = new Date(year, month, d);
    if (daysOfWeek.includes(date.getDay())) {
      result.push(formatDate(date));
    }
  }
  return result;
}
