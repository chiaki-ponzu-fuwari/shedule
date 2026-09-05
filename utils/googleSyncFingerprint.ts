import type { NoteItem } from '../types';

/** Googleへ送る内容が前回と同じなら update API を省略するための指紋 */
export function fingerprintForGooglePush(
  item: Pick<NoteItem, 'text' | 'time' | 'endTime' | 'url'>
): string {
  return [item.text ?? '', item.time ?? '', item.endTime ?? '', item.url ?? ''].join('\u0001');
}
