// Small encoders written by hand so this package needs neither Node's Buffer nor
// browser globals: it has to run unchanged in Node and in React Native.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));

/** base64url without padding */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += ALPHABET[b2 & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error('invalid base64url length');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = LOOKUP.get(char);
    if (value === undefined) throw new Error('invalid base64url character');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 255;
    }
  }
  // Leftover bits must be zero, so that every byte string has exactly one encoding.
  if ((buffer & ((1 << bits) - 1)) !== 0) throw new Error('invalid base64url padding bits');
  return out;
}

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++];
    const extra = b0 < 0x80 ? 0 : b0 < 0xe0 ? 1 : b0 < 0xf0 ? 2 : 3;
    let code = extra === 0 ? b0 : b0 & (0x3f >> extra);
    for (let n = 0; n < extra; n++) {
      if (i >= bytes.length) throw new Error('invalid utf-8');
      code = (code << 6) | (bytes[i++] & 63);
    }
    out += String.fromCodePoint(code);
  }
  return out;
}
