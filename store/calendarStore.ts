import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DayEntry, MiniStamps, PrivacyLevel, RecurringSchedule, SpecialDate, TimeSlot } from '../types';
import { getDatesForWeekdays } from '../utils/dateUtils';

interface CalendarState {
  entries: Record<string, DayEntry>;
  recurringSchedules: RecurringSchedule[];
  specialDates: SpecialDate[];
  weekStartDay: 0 | 1; // 0=日曜始まり, 1=月曜始まり

  // Settings
  setWeekStartDay: (day: 0 | 1) => void;

  // Entry mutations
  setMainStamp: (date: string, stampId: string | undefined) => void;
  setMiniStamp: (date: string, position: 'left' | 'right', stampId: string | undefined) => void;
  setNotes: (date: string, notes: string) => void;
  setNoteItems: (date: string, items: string[]) => void;
  setPrivacyLevel: (date: string, level: PrivacyLevel) => void;
  setStartTime: (date: string, time: string) => void;
  setEndTime: (date: string, time: string) => void;
  setNotification: (date: string, enabled: boolean) => void;
  setImageUri: (date: string, uri: string | undefined) => void;
  setDiary: (date: string, text: string) => void;
  setDiaryPhotos: (date: string, uris: string[]) => void;
  addTimeSlot: (date: string, slot: Omit<TimeSlot, 'id'>) => void;
  updateTimeSlot: (date: string, slotId: string, updates: Partial<Omit<TimeSlot, 'id'>>) => void;
  removeTimeSlot: (date: string, slotId: string) => void;
  getEntry: (date: string) => DayEntry | undefined;
  clearDay: (date: string) => void;

  // Recurring
  addRecurring: (schedule: RecurringSchedule) => void;
  removeRecurring: (id: string) => void;
  applyRecurring: (scheduleId: string, year: number, month: number) => void;

  // Special dates
  addSpecialDate: (date: SpecialDate) => void;
  removeSpecialDate: (id: string) => void;
  updateSpecialDate: (id: string, updates: Partial<SpecialDate>) => void;
}

function emptyEntry(date: string): DayEntry {
  return { date, miniStamps: {}, privacyLevel: 2 };
}

export const useCalendarStore = create<CalendarState>()(
  persist(
    (set, get) => ({
      entries: {},
      recurringSchedules: [],
      specialDates: [],
      weekStartDay: 1,

      setWeekStartDay: (day) => set({ weekStartDay: day }),

      getEntry: (date) => get().entries[date],

      setMainStamp: (date, stampId) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: {
              ...emptyEntry(date),
              ...state.entries[date],
              mainStampId: stampId,
            },
          },
        })),

      setMiniStamp: (date, position, stampId) =>
        set((state) => {
          const existing = state.entries[date] ?? emptyEntry(date);
          const miniStamps: MiniStamps = {
            ...existing.miniStamps,
            [position === 'left' ? 'left' : 'right']: stampId,
          };
          return {
            entries: {
              ...state.entries,
              [date]: { ...existing, miniStamps },
            },
          };
        }),

      setNotes: (date, notes) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: {
              ...emptyEntry(date),
              ...state.entries[date],
              notes,
            },
          },
        })),

      setNoteItems: (date, items) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: {
              ...emptyEntry(date),
              ...state.entries[date],
              noteItems: items,
            },
          },
        })),

      setPrivacyLevel: (date, level) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: { ...emptyEntry(date), ...state.entries[date], privacyLevel: level },
          },
        })),

      setStartTime: (date, time) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: { ...emptyEntry(date), ...state.entries[date], startTime: time },
          },
        })),

      setEndTime: (date, time) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: { ...emptyEntry(date), ...state.entries[date], endTime: time },
          },
        })),

      setNotification: (date, enabled) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: { ...emptyEntry(date), ...state.entries[date], notificationEnabled: enabled },
          },
        })),

      setImageUri: (date, uri) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: { ...emptyEntry(date), ...state.entries[date], imageUri: uri },
          },
        })),

      setDiary: (date, text) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: { ...emptyEntry(date), ...state.entries[date], diary: text },
          },
        })),

      setDiaryPhotos: (date, uris) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: { ...emptyEntry(date), ...state.entries[date], diaryPhotos: uris },
          },
        })),

      addTimeSlot: (date, slot) =>
        set((state) => {
          const existing = state.entries[date] ?? emptyEntry(date);
          const newSlot: TimeSlot = { ...slot, id: `ts_${Date.now()}` };
          return {
            entries: {
              ...state.entries,
              [date]: { ...existing, timeSlots: [...(existing.timeSlots ?? []), newSlot] },
            },
          };
        }),

      updateTimeSlot: (date, slotId, updates) =>
        set((state) => {
          const existing = state.entries[date] ?? emptyEntry(date);
          return {
            entries: {
              ...state.entries,
              [date]: {
                ...existing,
                timeSlots: (existing.timeSlots ?? []).map((s) =>
                  s.id === slotId ? { ...s, ...updates } : s
                ),
              },
            },
          };
        }),

      removeTimeSlot: (date, slotId) =>
        set((state) => {
          const existing = state.entries[date] ?? emptyEntry(date);
          return {
            entries: {
              ...state.entries,
              [date]: {
                ...existing,
                timeSlots: (existing.timeSlots ?? []).filter((s) => s.id !== slotId),
              },
            },
          };
        }),

      clearDay: (date) =>
        set((state) => {
          const next = { ...state.entries };
          delete next[date];
          return { entries: next };
        }),

      addRecurring: (schedule) =>
        set((state) => ({
          recurringSchedules: [...state.recurringSchedules, schedule],
        })),

      removeRecurring: (id) =>
        set((state) => ({
          recurringSchedules: state.recurringSchedules.filter((s) => s.id !== id),
        })),

      applyRecurring: (scheduleId, year, month) => {
        const { recurringSchedules, entries } = get();
        const schedule = recurringSchedules.find((s) => s.id === scheduleId);
        if (!schedule) return;

        const dates = getDatesForWeekdays(year, month, schedule.daysOfWeek);
        const newEntries = { ...entries };

        for (const date of dates) {
          const existing = newEntries[date] ?? emptyEntry(date);
          if (schedule.stampPosition === 'main') {
            newEntries[date] = { ...existing, mainStampId: schedule.stampId };
          } else if (schedule.stampPosition === 'mini-left') {
            newEntries[date] = {
              ...existing,
              miniStamps: { ...existing.miniStamps, left: schedule.stampId },
            };
          } else {
            newEntries[date] = {
              ...existing,
              miniStamps: { ...existing.miniStamps, right: schedule.stampId },
            };
          }
        }

        set({ entries: newEntries });
      },

      addSpecialDate: (date) =>
        set((state) => ({ specialDates: [...state.specialDates, date] })),

      removeSpecialDate: (id) =>
        set((state) => ({
          specialDates: state.specialDates.filter((s) => s.id !== id),
        })),

      updateSpecialDate: (id, updates) =>
        set((state) => ({
          specialDates: state.specialDates.map((s) =>
            s.id === id ? { ...s, ...updates } : s
          ),
        })),
    }),
    {
      name: 'calendar-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
