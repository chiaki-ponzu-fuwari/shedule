export type SharedContentIssueCode = 'unsafe-language' | 'unsafe-url' | 'invalid-url';

export interface SharedContentIssue {
  code: SharedContentIssueCode;
  field?: string;
}

export type SharedContentInspection =
  | { allowed: true; normalizedValue: string }
  | { allowed: false; normalizedValue: string; issue: SharedContentIssue };

const INVISIBLE_OR_DIRECTIONAL = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const DANGEROUS_SCHEME = /(?:javascript|vbscript)\s*:|data\s*:\s*text\s*\/\s*html|file\s*:/i;

// Keep this deliberately narrow. The filter catches explicit abuse while reports
// handle context-sensitive speech that a small on-device word list cannot judge.
const EXPLICIT_ABUSE_PATTERNS = [
  /死ね(?=$|[\s。、！？!?])/u,
  /殺すぞ|殺してやる/u,
  /\b(?:kill\s+yourself|i\s+will\s+kill\s+you)\b/i,
  /\b(?:child\s+porn(?:ography)?|underage\s+sex)\b/i,
  /児童ポルノ/u,
  /\b(?:nigg(?:er|a)|faggot)\b/i,
] as const;

export function normalizeModerationText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(INVISIBLE_OR_DIRECTIONAL, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .toLocaleLowerCase('en-US');
}

export function inspectSharedText(value: string): SharedContentInspection {
  const normalizedValue = normalizeModerationText(value);
  if (DANGEROUS_SCHEME.test(normalizedValue)) {
    return { allowed: false, normalizedValue, issue: { code: 'unsafe-url' } };
  }
  if (EXPLICIT_ABUSE_PATTERNS.some((pattern) => pattern.test(normalizedValue))) {
    return { allowed: false, normalizedValue, issue: { code: 'unsafe-language' } };
  }
  return { allowed: true, normalizedValue };
}

export function inspectSharedUrl(value: string): SharedContentInspection {
  const normalizedValue = normalizeModerationText(value);
  if (!normalizedValue) return { allowed: true, normalizedValue: '' };
  if (DANGEROUS_SCHEME.test(normalizedValue)) {
    return { allowed: false, normalizedValue, issue: { code: 'unsafe-url' } };
  }

  try {
    const parsed = new URL(normalizedValue);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return { allowed: false, normalizedValue, issue: { code: 'unsafe-url' } };
    }
    return { allowed: true, normalizedValue: parsed.toString() };
  } catch {
    return { allowed: false, normalizedValue, issue: { code: 'invalid-url' } };
  }
}

export type SharedPayloadInspection =
  | { allowed: true }
  | { allowed: false; issue: SharedContentIssue };

function isDedicatedUrlField(field: string): boolean {
  const leafName = field.split('.').at(-1) ?? '';
  return leafName.toLowerCase() === 'url'
    || /(?:_|-)url$/i.test(leafName)
    || /(?:Url|URL)$/.test(leafName);
}

export function filterSharedPayload(payload: unknown): SharedPayloadInspection {
  const visit = (value: unknown, field: string): SharedContentIssue | null => {
    if (typeof value === 'string') {
      const result = isDedicatedUrlField(field)
        ? inspectSharedUrl(value)
        : inspectSharedText(value);
      return result.allowed ? null : { ...result.issue, field };
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const issue = visit(value[index], `${field}[${index}]`);
        if (issue) return issue;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const issue = visit(child, field ? `${field}.${key}` : key);
        if (issue) return issue;
      }
    }
    return null;
  };

  const issue = visit(payload, '');
  return issue ? { allowed: false, issue } : { allowed: true };
}

export function assertSharedPayloadAllowed(payload: unknown): void {
  const result = filterSharedPayload(payload);
  if (!result.allowed) {
    const error = new Error(`unsafe_shared_content:${result.issue.code}:${result.issue.field ?? ''}`);
    error.name = 'UnsafeSharedContentError';
    throw error;
  }
}
