import { NoteItem } from '../types';
import { useLocaleStore } from '../store/localeStore';
import { tx } from '../constants/i18n';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

async function readGoogleError(res: Response): Promise<string> {
  try {
    const data: any = await res.json();
    const g = data?.error;
    const msg = g?.message || data?.message || '';
    const reason = g?.errors?.[0]?.reason;
    const status = g?.status || '';
    const parts = [
      `status=${res.status}`,
      status ? `googleStatus=${status}` : '',
      reason ? `reason=${reason}` : '',
      msg ? `message=${msg}` : '',
    ].filter(Boolean);
    return parts.join(' / ') || `status=${res.status}`;
  } catch {
    return `status=${res.status}`;
  }
}

export interface GoogleEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  /** cancelled のとき削除扱い（増分同期） */
  status?: string;
  htmlLink?: string;
  description?: string;
  location?: string;
  /** Google Meet など */
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{ uri?: string; entryPointType?: string }>;
  };
}

export class SyncTokenInvalidError extends Error {
  readonly code = 'SYNC_TOKEN_INVALID' as const;
  constructor() {
    super('SYNC_TOKEN_INVALID');
    this.name = 'SyncTokenInvalidError';
  }
}

// アクセストークンが有効かチェック
export async function checkTokenValid(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${CALENDAR_API}/calendars/primary`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkTokenValidOrThrow(accessToken: string): Promise<void> {
  const res = await fetch(`${CALENDAR_API}/calendars/primary`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google API error: ${await readGoogleError(res)}`);
}

/** ページング込みで一覧取得。nextSyncToken は最終ページのものを返す */
async function listEventsPaginated(
  accessToken: string,
  buildParams: (pageToken?: string) => URLSearchParams
): Promise<{ events: GoogleEvent[]; nextSyncToken?: string }> {
  const events: GoogleEvent[] = [];
  let nextSyncToken: string | undefined;
  let pageToken: string | undefined;
  for (;;) {
    const params = buildParams(pageToken);
    const res = await fetch(`${CALENDAR_API}/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 410) {
      throw new SyncTokenInvalidError();
    }
    if (!res.ok) throw new Error(`Google API error: ${await readGoogleError(res)}`);
    const data = await res.json();
    events.push(...(data.items ?? []));
    if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return { events, nextSyncToken };
}

/** 期間指定のフル同期（初回・トークン失効後） */
export async function listPrimaryCalendarEventsForRange(
  accessToken: string,
  dateMin: string,
  dateMax: string
): Promise<{ events: GoogleEvent[]; nextSyncToken?: string }> {
  const timeMin = `${dateMin}T00:00:00+09:00`;
  const timeMax = `${dateMax}T23:59:59+09:00`;
  return listEventsPaginated(accessToken, (pt) => {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      timeZone: 'Asia/Tokyo',
    });
    if (pt) params.set('pageToken', pt);
    return params;
  });
}

/** 増分同期（変更・削除分のみ。410なら SyncTokenInvalidError） */
export async function listPrimaryCalendarEventsIncremental(
  accessToken: string,
  syncToken: string
): Promise<{ events: GoogleEvent[]; nextSyncToken?: string }> {
  return listEventsPaginated(accessToken, (pt) => {
    const params = new URLSearchParams({
      syncToken,
      singleEvents: 'true',
      maxResults: '250',
      timeZone: 'Asia/Tokyo',
    });
    if (pt) params.set('pageToken', pt);
    return params;
  });
}

/** @deprecated listPrimaryCalendarEventsForRange を利用 */
export async function fetchGoogleEvents(
  accessToken: string,
  dateMin: string,
  dateMax: string
): Promise<GoogleEvent[]> {
  const { events } = await listPrimaryCalendarEventsForRange(accessToken, dateMin, dateMax);
  return events;
}

// GoogleイベントをNoteItemに変換
export function googleEventToNoteItem(event: GoogleEvent): NoteItem {
  const startRaw = event.start.dateTime ?? event.start.date ?? '';
  const endRaw = event.end.dateTime ?? event.end.date ?? '';

  const parseTime = (dt: string) => {
    if (dt.includes('T')) {
      // dateTime形式: "2026-03-25T09:00:00+09:00"
      const d = new Date(dt);
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      return `${h}:${m}`;
    }
    return undefined; // 終日イベントは時間なし
  };

  // 予定に「貼ったURL」だけ反映（Googleカレンダー本体の htmlLink は付けない）
  const extractUrl = (text?: string) => {
    if (!text) return undefined;
    const m = text.match(/https?:\/\/[^\s<>"')]+/);
    return m?.[0]?.replace(/[.,;:)]+$/u, '');
  };

  const conferenceVideoUri = event.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === 'video' && e.uri?.startsWith('http')
  )?.uri;
  const conferenceAnyUri = event.conferenceData?.entryPoints?.find((e) => e.uri?.startsWith('http'))?.uri;

  const url =
    extractUrl(event.description) ||
    extractUrl(event.location) ||
    conferenceVideoUri ||
    conferenceAnyUri ||
    (event.hangoutLink?.startsWith('http') ? event.hangoutLink : undefined);

  return {
    id: `g_${event.id}`,
    text: event.summary?.trim()
      ? event.summary
      : tx(useLocaleStore.getState().locale, 'google.noTitle'),
    time: parseTime(startRaw),
    endTime: parseTime(endRaw),
    url,
    fromGoogleId: event.id,
    googleSyncDirection: 'fromGoogle',
    color: '#34A853', // Google green
  };
}

// GoogleイベントのdateをYYYY-MM-DDに変換
export function googleEventDate(event: GoogleEvent): string {
  const raw = event.start.dateTime ?? event.start.date ?? '';
  if (raw.includes('T')) {
    return raw.split('T')[0];
  }
  return raw;
}

// NoteItemをGoogleカレンダーに投稿
export async function createGoogleEvent(
  accessToken: string,
  date: string, // YYYY-MM-DD
  item: NoteItem
): Promise<string | null> {
  const makeDateTime = (d: string, t?: string) =>
    t ? `${d}T${t}:00` : undefined;

  const body: any = {
    summary: item.text,
    start: item.time
      ? { dateTime: makeDateTime(date, item.time), timeZone: 'Asia/Tokyo' }
      : { date },
    end: item.endTime
      ? { dateTime: makeDateTime(date, item.endTime), timeZone: 'Asia/Tokyo' }
      : item.time
      ? { dateTime: makeDateTime(date, item.time), timeZone: 'Asia/Tokyo' }
      : { date },
  };

  if (item.url) body.description = item.url;

  const res = await fetch(`${CALENDAR_API}/calendars/primary/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google API error: ${await readGoogleError(res)}`);
  const data = await res.json();
  return data.id ?? null;
}

// Googleイベントを更新
export async function updateGoogleEvent(
  accessToken: string,
  eventId: string,
  date: string,
  item: NoteItem
): Promise<boolean> {
  const makeDateTime = (d: string, t?: string) =>
    t ? `${d}T${t}:00` : undefined;

  const body: any = {
    summary: item.text,
    start: item.time
      ? { dateTime: makeDateTime(date, item.time), timeZone: 'Asia/Tokyo' }
      : { date },
    end: item.endTime
      ? { dateTime: makeDateTime(date, item.endTime), timeZone: 'Asia/Tokyo' }
      : item.time
      ? { dateTime: makeDateTime(date, item.time), timeZone: 'Asia/Tokyo' }
      : { date },
  };

  if (item.url) body.description = item.url;

  const res = await fetch(`${CALENDAR_API}/calendars/primary/events/${eventId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google API error: ${await readGoogleError(res)}`);
  return true;
}

// Googleイベントを削除
export async function deleteGoogleEvent(
  accessToken: string,
  eventId: string
): Promise<boolean> {
  const res = await fetch(`${CALENDAR_API}/calendars/primary/events/${eventId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.status === 204 || res.ok;
}
