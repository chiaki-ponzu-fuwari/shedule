import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DayEntry, MiniStamps, NoteItem, PrivacyLevel, RecurringSchedule, SpecialDate, TimeSlot } from '../types';
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
  setNoteItems: (date: string, items: NoteItem[]) => void;
  setPrivacyLevel: (date: string, level: PrivacyLevel) => void;
  setStartTime: (date: string, time: string) => void;
  setEndTime: (date: string, time: string) => void;
  setNotification: (date: string, enabled: boolean) => void;
  setNotificationId: (date: string, id: string | undefined) => void;
  setImageUri: (date: string, uri: string | undefined) => void;
  setDiary: (date: string, text: string) => void;
  setDiaryPhotos: (date: string, uris: string[]) => void;
  setDiaryConfirmed: (date: string, confirmed: boolean) => void;
  setDailyGoal: (date: string, goal: string) => void;
  addTimeSlot: (date: string, slot: Omit<TimeSlot, 'id'>) => void;
  upsertTimeSlot: (date: string, slot: TimeSlot) => void;
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

      setNotificationId: (date, id) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: { ...emptyEntry(date), ...state.entries[date], notificationId: id },
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

      setDiaryConfirmed: (date, confirmed) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: { ...emptyEntry(date), ...state.entries[date], diaryConfirmed: confirmed },
          },
        })),

      setDailyGoal: (date, goal) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [date]: { ...emptyEntry(date), ...state.entries[date], dailyGoal: goal },
          },
        })),

      addTimeSlot: (date, slot) =>
        set((state) => {
          const existing = state.entries[date] ?? emptyEntry(date);
          const newSlot: TimeSlot = { ...slot, id: `ts_${Date.now()}` };
          let noteItems = existing.noteItems ?? [];
          if (slot.reflectToMonthly) {
            noteItems = [...noteItems, {
              id: `ni_${newSlot.id}`,
              text: newSlot.title,
              time: newSlot.startTime,
              endTime: newSlot.endTime,
              url: newSlot.url,
              fromTimeSlotId: newSlot.id,
              notificationEnabled: false,
            }];
          }
          return {
            entries: {
              ...state.entries,
              [date]: { ...existing, timeSlots: [...(existing.timeSlots ?? []), newSlot], noteItems },
            },
          };
        }),

      upsertTimeSlot: (date, slot) =>
        set((state) => {
          const existing = state.entries[date] ?? emptyEntry(date);
          const slots = existing.timeSlots ?? [];
          const idx = slots.findIndex((s) => s.id === slot.id);
          const nextSlots = idx >= 0 ? slots.map((s) => (s.id === slot.id ? slot : s)) : [...slots, slot];

          // 既に紐付いているNoteItemがあれば同期（URLも含める）
          const existingNoteItems = existing.noteItems ?? [];
          const linkedIdx = existingNoteItems.findIndex((n) => n.fromTimeSlotId === slot.id);
          let noteItems = existingNoteItems;
          if (linkedIdx >= 0) {
            const existingLinked = existingNoteItems[linkedIdx];
            const updatedLinked: NoteItem = {
              ...existingLinked,
              text: slot.title,
              time: slot.startTime,
              endTime: slot.endTime,
              url: slot.url,
              fromTimeSlotId: slot.id,
              notificationEnabled: slot.notificationEnabled ?? existingLinked.notificationEnabled ?? false,
              notificationId: slot.notificationId ?? existingLinked.notificationId,
            };
            noteItems = existingNoteItems.map((n, i) => (i === linkedIdx ? updatedLinked : n));
          } else if (slot.reflectToMonthly) {
            noteItems = [
              ...existingNoteItems,
              {
                id: `ni_${slot.id}`,
                text: slot.title,
                time: slot.startTime,
                endTime: slot.endTime,
                url: slot.url,
                fromTimeSlotId: slot.id,
                notificationEnabled: slot.notificationEnabled ?? false,
                notificationId: slot.notificationId,
              },
            ];
          }

          return {
            entries: {
              ...state.entries,
              [date]: { ...existing, timeSlots: nextSlots, noteItems },
            },
          };
        }),

      updateTimeSlot: (date, slotId, updates) =>
        set((state) => {
          const existing = state.entries[date] ?? emptyEntry(date);
          const updatedSlots = (existing.timeSlots ?? []).map((s) =>
            s.id === slotId ? { ...s, ...updates } : s
          );
          const updatedSlot = updatedSlots.find((s) => s.id === slotId);
          // マンスリー反映NoteItemを同期（順序・通知設定を保持したまま更新）
          const existingNoteItems = existing.noteItems ?? [];
          const linkedIdx = existingNoteItems.findIndex((n) => n.fromTimeSlotId === slotId);
          let noteItems: NoteItem[];
          if (updatedSlot?.reflectToMonthly) {
            const existingLinked = linkedIdx >= 0 ? existingNoteItems[linkedIdx] : undefined;
            const updatedLinked: NoteItem = {
              id: existingLinked?.id ?? `ni_${slotId}`,
              ...(existingLinked ?? {}),
              text: updatedSlot.title,
              time: updatedSlot.startTime,
              endTime: updatedSlot.endTime,
              url: updatedSlot.url,
              fromTimeSlotId: slotId,
              notificationEnabled: updatedSlot.notificationEnabled ?? existingLinked?.notificationEnabled ?? false,
              notificationId: updatedSlot.notificationId ?? existingLinked?.notificationId,
            };
            if (linkedIdx >= 0) {
              noteItems = existingNoteItems.map((n, i) => i === linkedIdx ? updatedLinked : n);
            } else {
              noteItems = [...existingNoteItems, updatedLinked];
            }
          } else {
            noteItems = existingNoteItems.filter((n) => n.fromTimeSlotId !== slotId);
          }
          return {
            entries: {
              ...state.entries,
              [date]: { ...existing, timeSlots: updatedSlots, noteItems },
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
                noteItems: (existing.noteItems ?? []).filter((n) => n.fromTimeSlotId !== slotId),
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

        const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
        const updatedSchedules = recurringSchedules.map((s) =>
          s.id === scheduleId
            ? { ...s, appliedMonths: Array.from(new Set([...(s.appliedMonths ?? []), monthKey])).sort() }
            : s
        );

        set({ entries: newEntries, recurringSchedules: updatedSchedules });
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
