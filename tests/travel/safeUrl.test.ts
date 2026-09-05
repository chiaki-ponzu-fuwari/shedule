import { normalizeSafeUrl } from '../../utils/safeUrl';

describe('travel URL safety', () => {
  test.each([
    ['example.com', 'https://example.com/'],
    ['https://hotel.example/r/1', 'https://hotel.example/r/1'],
    ['http://maps.example/place', 'http://maps.example/place'],
    ['javascript:alert(1)', null],
    ['file:///private/a', null],
    ['https://name:secret@example.com', null],
    ['https://example.com/\u0000hidden', null],
  ])('normalizes %p safely', (input, expected) => {
    expect(normalizeSafeUrl(input)).toBe(expected);
  });

  test('treats an empty optional URL as absent', () => {
    expect(normalizeSafeUrl('   ')).toBeUndefined();
  });
});
