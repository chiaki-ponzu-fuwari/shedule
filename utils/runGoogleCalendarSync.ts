import { useCalendarStore } from '../store/calendarStore';
import { useGoogleSyncStore } from '../store/googleSyncStore';
import { useGoogleAuthStore } from '../store/googleAuthStore';
import type { NoteItem } from '../types';
import { fingerprintForGooglePush } from './googleSyncFingerprint';
import type { GoogleEvent } from './googleCalendar';
import {
  listPrimaryCalendarEventsForRange,
  listPrimaryCalendarEventsIncremental,
  googleEventToNoteItem,
  googleEventDate,
  createGoogleEvent,
  updateGoogleEvent,
  SyncTokenInvalidError,
} from './googleCalendar';

/** UI はロケールに合わせた文言を出す（エラー比較用の固定コード） */
export const GOOGLE_SYNC_NEEDS_LOGIN = 'GOOGLE_SYNC_NEEDS_LOGIN';

export type GoogleCalendarSyncResult =
  | {
      ok: true;
      imported: number;
      fromGoogleUpdated: number;
      fromGoogleRemoved: number;
      exportedCreated: number;
      exportedUpdated: number;
      exportedSkipped: number;
      syncedAtIso: string;
    }
  | { ok: false; error: string; needsReauth?: boolean };

function findNoteItemByGoogleId(googleEventId: string): { date: string; index: number } | null {
  const entries = useCalendarStore.getState().entries;
  for (const date of Object.keys(entries)) {
    const noteItems = entries[date]?.noteItems ?? [];
    const idx = noteItems.findIndex((n) => n.fromGoogleId === googleEventId);
    if (idx >= 0) return { date, index: idx };
  }
  return null;
}

function removeGoogleSyncedEventLocal(googleEventId: string) {
  const found = findNoteItemByGoogleId(googleEventId);
  if (!found) return;
  const { date, index } = found;
  const setNoteItems = useCalendarStore.getState().setNoteItems;
  const removeTimeSlot = useCalendarStore.getState().removeTimeSlot;
  const entry = useCalendarStore.getState().entries[date];
  const noteItems = [...(entry?.noteItems ?? [])];
  noteItems.splice(index, 1);
  setNoteItems(date, noteItems);
  removeTimeSlot(date, `ts_g_${googleEventId}`);
}

function upsertTimeSlotForGoogle(date: string, nextItem: NoteItem, slotId: string) {
  if (!nextItem.time || !nextItem.endTime) return;
  useCalendarStore.getState().upsertTimeSlot(date, {
    id: slotId,
    startTime: nextItem.time,
    endTime: nextItem.endTime,
    title: nextItem.text,
    color: nextItem.color ?? '#34A853',
    url: nextItem.url,
    reflectToMonthly: false,
  });
}

/** Google側の1イベントをローカルへ反映（新規・更新・日付移動） */
function applyGoogleEventToLocal(ev: GoogleEvent, found: { date: string; index: number } | null) {
  const date = googleEventDate(ev);
  const item = googleEventToNoteItem(ev);
  const slotId = `ts_g_${ev.id}`;
  const nextItem: NoteItem = { ...item, fromTimeSlotId: slotId };
  const setNoteItems = useCalendarStore.getState().setNoteItems;

  if (!found) {
    const existing = useCalendarStore.getState().entries[date]?.noteItems ?? [];
    setNoteItems(date, [...existing, nextItem]);
    upsertTimeSlotForGoogle(date, nextItem, slotId);
    return;
  }

  if (found.date !== date) {
    removeGoogleSyncedEventLocal(ev.id);
    const existingNew = useCalendarStore.getState().entries[date]?.noteItems ?? [];
    setNoteItems(date, [...existingNew, nextItem]);
    upsertTimeSlotForGoogle(date, nextItem, slotId);
    return;
  }

  const arr = [...(useCalendarStore.getState().entries[date]?.noteItems ?? [])];
  arr[found.index] = nextItem;
  setNoteItems(date, arr);
  upsertTimeSlotForGoogle(date, nextItem, slotId);
}

async function pullFromGoogle(
  accessToken: string,
  dateMin: string,
  dateMax: string
): Promise<{
  imported: number;
  fromGoogleUpdated: number;
  fromGoogleRemoved: number;
}> {
  const setCalendarListSyncToken = useGoogleSyncStore.getState().setCalendarListSyncToken;
  const clearCalendarListSyncToken = useGoogleSyncStore.getState().clearCalendarListSyncToken;
  let storedToken = useGoogleSyncStore.getState().calendarListSyncToken;

  let events: GoogleEvent[];
  let nextSyncToken: string | undefined;

  if (storedToken) {
    try {
      const inc = await listPrimaryCalendarEventsIncremental(accessToken, storedToken);
      events = inc.events;
      nextSyncToken = inc.nextSyncToken;
    } catch (e) {
      if (e instanceof SyncTokenInvalidError) {
        clearCalendarListSyncToken();
        const full = await listPrimaryCalendarEventsForRange(accessToken, dateMin, dateMax);
        events = full.events;
        nextSyncToken = full.nextSyncToken;
      } else {
        throw e;
      }
    }
  } else {
    const full = await listPrimaryCalendarEventsForRange(accessToken, dateMin, dateMax);
    events = full.events;
    nextSyncToken = full.nextSyncToken;
  }

  let imported = 0;
  let fromGoogleUpdated = 0;
  let fromGoogleRemoved = 0;

  for (const ev of events) {
    if (ev.status === 'cancelled') {
      if (findNoteItemByGoogleId(ev.id)) {
        removeGoogleSyncedEventLocal(ev.id);
        fromGoogleRemoved += 1;
      }
      continue;
    }

    const found = findNoteItemByGoogleId(ev.id);
    if (!found) {
      applyGoogleEventToLocal(ev, null);
      imported += 1;
    } else {
      applyGoogleEventToLocal(ev, found);
      fromGoogleUpdated += 1;
    }
  }

  if (nextSyncToken) {
    setCalendarListSyncToken(nextSyncToken);
  }

  return { imported, fromGoogleUpdated, fromGoogleRemoved };
}

export async function runGoogleCalendarSync(opts?: { silent?: boolean }): Promise<GoogleCalendarSyncResult> {
  void opts?.silent;
  const { getAccessToken, signOut } = useGoogleAuthStore.getState();
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, error: GOOGLE_SYNC_NEEDS_LOGIN };
  }

  try {
    const googleSyncMode = useGoogleSyncStore.getState().mode;
    const setNoteItems = useCalendarStore.getState().setNoteItems;
    const setLastSyncedAt = useGoogleSyncStore.getState().setLastSyncedAt;

    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const to = new Date(today.getFullYear(), today.getMonth() + 3, 0);
    const fmt = (d: Date) => d.toISOString().split('T')[0];

    let imported = 0;
    let fromGoogleUpdated = 0;
    let fromGoogleRemoved = 0;
    let exportedCreated = 0;
    let exportedUpdated = 0;
    let exportedSkipped = 0;

    if (googleSyncMode === 'fromGoogle' || googleSyncMode === 'both') {
      const pull = await pullFromGoogle(token, fmt(from), fmt(to));
      imported = pull.imported;
      fromGoogleUpdated = pull.fromGoogleUpdated;
      fromGoogleRemoved = pull.fromGoogleRemoved;
    }

    if (googleSyncMode === 'toGoogle' || googleSyncMode === 'both') {
      const fromStr = fmt(from);
      const toStr = fmt(to);
      const allDates = Object.keys(useCalendarStore.getState().entries)
        .filter((d) => d >= fromStr && d <= toStr)
        .sort();

      for (const date of allDates) {
        const existing = useCalendarStore.getState().entries[date]?.noteItems ?? [];
        if (existing.length === 0) continue;

        const next: NoteItem[] = [...existing];
        let changed = false;

        for (let i = 0; i < next.length; i++) {
          const item = next[i];
          if (item.googleSyncDirection === 'fromGoogle') continue;
          if (!item.text?.trim()) continue;

          const fp = fingerprintForGooglePush(item);

          if (item.fromGoogleId) {
            if (item.googlePushFingerprint === fp) {
              exportedSkipped += 1;
              continue;
            }
            await updateGoogleEvent(token, item.fromGoogleId, date, item);
            next[i] = { ...item, googlePushFingerprint: fp };
            changed = true;
            exportedUpdated += 1;
          } else {
            const newId = await createGoogleEvent(token, date, item);
            if (newId) {
              next[i] = {
                ...item,
                fromGoogleId: newId,
                googlePushFingerprint: fp,
                googleSyncDirection: item.googleSyncDirection || 'toGoogle',
                syncToGoogle: true,
              };
              changed = true;
              exportedCreated += 1;
            }
          }
        }

        if (changed) setNoteItems(date, next);
      }
    }

    const nowIso = new Date().toISOString();
    setLastSyncedAt(nowIso);

    return {
      ok: true,
      imported,
      fromGoogleUpdated,
      fromGoogleRemoved,
      exportedCreated,
      exportedUpdated,
      exportedSkipped,
      syncedAtIso: nowIso,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const s = String(msg);
    if (s.includes('401') || s.includes('UNAUTHENTICATED')) {
      await signOut();
      return {
        ok: false,
        error: 'Googleログインの有効期限が切れました。もう一度ログインしてください。',
        needsReauth: true,
      };
    }
    return { ok: false, error: s };
  }
}
