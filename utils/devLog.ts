/**
 * 本番ビルドでは出力しない診断用ログ。
 * トークン・認可コード・レスポンス本文を引数に渡さないこと。
 */
export function devError(tag: string, detail?: string | number | null): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;
  if (detail !== undefined && detail !== null && detail !== '') {
    console.error(`[dev] ${tag}`, detail);
  } else {
    console.error(`[dev] ${tag}`);
  }
}

export function devWarn(tag: string, detail?: string): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;
  console.warn(`[dev] ${tag}`, detail ?? '');
}
