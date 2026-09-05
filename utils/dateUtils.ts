import { DayInfo, SpecialDate } from '../types';
import type { AppLocale } from '../store/localeStore';

const WEEKDAY_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

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

export function getMonthLabel(year: number, month: number, locale: AppLocale = 'ja'): string {
  if (locale === 'en') {
    return new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  return `${year}年${month + 1}月`;
}

/** calMonth は 1〜12 */
export function formatCalendarMonthTitle(year: number, calMonth: number, locale: AppLocale = 'ja'): string {
  if (locale === 'en') {
    return new Date(year, calMonth - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  return `${year}年${calMonth}月`;
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

/** ローカル日単位で a から b までの日数（同日なら 0） */
export function daysBetweenCalendar(a: Date, b: Date): number {
  const u = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const v = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((v - u) / 86400000);
}

/** その日を含む週の開始日（weekStartDay: 0=日, 1=月） */
export function startOfWeekForDate(date: Date, weekStartDay: number = 1): Date {
  const day = date.getDay();
  const offset = (day - weekStartDay + 7) % 7;
  return addDays(date, -offset);
}

/** Returns all day cells for a monthly view (including padding from prev/next month) */
export function getMonthDays(year: number, month: number, specialDates: SpecialDate[] = [], weekStartDay: number = 1): DayInfo[] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);

  // weekStartDay: 0=日曜, 1=月曜
  const startOffset = (firstDay.getDay() - weekStartDay + 7) % 7;
  const start = new Date(year, month, 1 - startOffset);

  // 週の最終曜日で終わる
  const lastDayOfWeek = (weekStartDay + 6) % 7;
  const endOffset = (lastDayOfWeek - lastDay.getDay() + 7) % 7;
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

/** Returns 7 days starting from the weekStartDay of the week containing `date` */
export function getWeekDays(date: Date, specialDates: SpecialDate[] = [], weekStartDay: number = 1): DayInfo[] {
  const day = date.getDay(); // 0=Sun
  const startOffset = (day - weekStartDay + 7) % 7;
  const weekStart = addDays(date, -startOffset);
  const days: DayInfo[] = [];

  for (let i = 0; i < 7; i++) {
    const cur = addDays(weekStart, i);
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

/** weekStartDay(0=日, 1=月) に応じた7曜日ラベルと曜日番号を返す */
export function getWeekdayLabels(weekStartDay: number = 1, locale: AppLocale = 'ja'): { label: string; day: number }[] {
  return Array.from({ length: 7 }, (_, i) => {
    const day = (weekStartDay + i) % 7;
    const label = locale === 'en' ? WEEKDAY_SHORT_EN[day] : WEEKDAY_LABELS[day];
    return { label, day };
  });
}

export function formatMonthDay(dateStr: string, locale: AppLocale = 'ja'): string {
  const d = parseDate(dateStr);
  if (locale === 'en') {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatFullDate(dateStr: string, locale: AppLocale = 'ja'): string {
  const d = parseDate(dateStr);
  if (locale === 'en') {
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
  }
  const w = WEEKDAY_LABELS[d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${w}）`;
}

/** テーブル用 M/D と曜日略称 */
export function formatShortDateParts(dateStr: string, locale: AppLocale = 'ja'): { date: string; day: string; dayIdx: number } {
  const d = new Date(dateStr + 'T00:00:00');
  const dayIdx = d.getDay();
  const day = locale === 'en' ? WEEKDAY_SHORT_EN[dayIdx] : WEEKDAY_LABELS[dayIdx];
  return {
    date: `${d.getMonth() + 1}/${d.getDate()}`,
    day,
    dayIdx,
  };
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
