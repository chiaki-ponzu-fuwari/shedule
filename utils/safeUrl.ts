const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export function normalizeSafeUrl(input: string): string | null | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 2048 || CONTROL_CHARACTERS.test(trimmed)) return null;

  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
