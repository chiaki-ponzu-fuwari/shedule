import {
  filterSharedPayload,
  inspectSharedText,
  inspectSharedUrl,
  normalizeModerationText,
} from '../../lib/moderation/contentFilter';

describe('shared content filter', () => {
  test('normalizes width, case, and invisible separator bypasses', () => {
    expect(normalizeModerationText(' Ｊ​ＡＶＡＳＣＲＩＰＴ：alert(1) ')).toBe(
      'javascript:alert(1)'
    );
  });

  test.each([
    ['https://example.com/trip?id=1', true],
    ['http://example.com', true],
    ['', true],
    ['javascript:alert(1)', false],
    ['data:text/html,<script>alert(1)</script>', false],
    ['https://name:secret@example.com', false],
    ['example.com/no-scheme', false],
  ])('validates a dedicated shared URL %s without blocking normal web links', (value, allowed) => {
    expect(inspectSharedUrl(value).allowed).toBe(allowed);
  });

  test('blocks explicit threats and dangerous embedded schemes', () => {
    expect(inspectSharedText('お前は死ね。').allowed).toBe(false);
    expect(inspectSharedText('I will kill you tonight').allowed).toBe(false);
    expect(inspectSharedText('Open j​avascript:alert(1)').allowed).toBe(false);
  });

  test('does not reject benign substrings, ordinary travel details, or HTTPS URLs', () => {
    expect(inspectSharedText('死ねないくらい忙しい日').allowed).toBe(true);
    expect(inspectSharedText('Class assignment: analyze the word assassin.').allowed).toBe(true);
    expect(inspectSharedText('Flight KYS to BKO')).toEqual(
      expect.objectContaining({ allowed: true })
    );
    expect(inspectSharedText('宿泊先 https://hotel.example/reservation/123').allowed).toBe(true);
  });

  test('recognizes camelCase and uppercase dedicated URL fields', () => {
    expect(filterSharedPayload({ bookingUrl: 'hotel.example/booking' })).toEqual(
      expect.objectContaining({
        allowed: false,
        issue: expect.objectContaining({ code: 'invalid-url', field: 'bookingUrl' }),
      })
    );
    expect(filterSharedPayload({ confirmationURL: 'https://hotel.example/booking' })).toEqual({
      allowed: true,
    });
  });

  test('identifies the precise unsafe field in a schedule payload', () => {
    const result = filterSharedPayload({
      groupName: '台湾旅行',
      notes: '桃園空港で集合',
      timeSlots: [
        { title: 'ホテル', url: 'https://hotel.example' },
        { title: '移動', url: 'file:///private/secret' },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        issue: expect.objectContaining({ code: 'unsafe-url', field: 'timeSlots[1].url' }),
      })
    );
  });
});
