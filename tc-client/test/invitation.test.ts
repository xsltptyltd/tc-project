import { beforeAll, describe, expect, it } from 'vitest';
import { generateIdentity, init, newInvitationSecret } from 'tc-crypto';
import { textInvitationCodec } from '../src';

beforeAll(() => init());

describe('the terminal invitation code', () => {
  const invitation = { inviter: generateIdentity().deviceId, secret: newInvitationSecret() };
  const code = textInvitationCodec.encode(invitation);

  it('round-trips, ignoring whitespace around it', () => {
    expect(textInvitationCodec.decode(code)).toEqual(invitation);
    expect(textInvitationCodec.decode(`  ${code}\n`)).toEqual(invitation);
  });

  it('is one copyable word', () => {
    expect(code).toMatch(/^tc1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  });

  it.each([
    ['empty', ''],
    ['cut short', code.slice(0, -1)],
    ['without its prefix', code.slice(4)],
    ['another version', code.replace(/^tc1/, 'tc2')],
    ['a device id alone', invitation.inviter],
    ['an extra part', `${code}.x`],
    ['a character outside base64url', code.replace(/.$/, '+')],
    ['a last character mistyped into one that cannot end 32 bytes', code.replace(/.$/, code.endsWith('B') ? 'C' : 'B')],
  ])('reads nothing from %s', (_label, text) => {
    expect(textInvitationCodec.decode(text)).toBeUndefined();
  });
});
