import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from '../src/encoding';

describe('base64url', () => {
  it('matches Node for every length from 0 to 70', () => {
    for (let length = 0; length <= 70; length++) {
      const bytes = randomBytes(length);
      const text = toBase64Url(bytes);
      expect(text).toBe(bytes.toString('base64url'));
      expect(Buffer.from(fromBase64Url(text))).toEqual(bytes);
    }
  });

  it.each(['a', 'ab+d', 'ab d', 'abc=', 'AB', 'AAB'])('rejects %j', (text) => {
    expect(() => fromBase64Url(text)).toThrow();
  });
});

describe('utf-8', () => {
  it.each(['', 'hello', 'café', '日本語', '👋🏽 émoji', 'a\u0000b'])('matches Node for %j', (text) => {
    expect(Buffer.from(utf8Encode(text))).toEqual(Buffer.from(text, 'utf8'));
    expect(utf8Decode(utf8Encode(text))).toBe(text);
  });
});
