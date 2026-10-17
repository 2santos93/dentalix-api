import {
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  matchTotp,
  totpCode,
  totpStep,
  totpUri,
} from './totp';

// Claves de los vectores del RFC 6238, apéndice B (ASCII "1234567890"
// repetido hasta 20, 32 y 64 bytes).
const SHA1_KEY = Buffer.from('12345678901234567890');
const SHA256_KEY = Buffer.from('12345678901234567890123456789012');
const SHA512_KEY = Buffer.from(
  '1234567890123456789012345678901234567890123456789012345678901234',
);

describe('TOTP (RFC 6238)', () => {
  it.each([
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ])('vector del RFC en T=%i', (seconds, sha1, sha256, sha512) => {
    const step = totpStep(seconds * 1000);
    expect(totpCode(SHA1_KEY, step, 8, 'sha1')).toBe(sha1);
    expect(totpCode(SHA256_KEY, step, 8, 'sha256')).toBe(sha256);
    expect(totpCode(SHA512_KEY, step, 8, 'sha512')).toBe(sha512);
  });

  it('6 dígitos son los 6 últimos del vector de 8 (RFC 4226)', () => {
    expect(totpCode(SHA1_KEY, totpStep(59_000))).toBe('287082');
  });

  describe('matchTotp', () => {
    const now = 1_111_111_111_000;
    const step = totpStep(now);

    it('acepta el paso actual y ±1, no ±2', () => {
      for (const offset of [-1, 0, 1]) {
        expect(
          matchTotp(SHA1_KEY, totpCode(SHA1_KEY, step + offset), now, null),
        ).toBe(step + offset);
      }
      for (const offset of [-2, 2]) {
        expect(
          matchTotp(SHA1_KEY, totpCode(SHA1_KEY, step + offset), now, null),
        ).toBeNull();
      }
    });

    it('anti-replay: rechaza el paso ya usado y los anteriores', () => {
      const code = totpCode(SHA1_KEY, step);
      expect(matchTotp(SHA1_KEY, code, now, step)).toBeNull();
      expect(matchTotp(SHA1_KEY, code, now, step + 1)).toBeNull();
      expect(matchTotp(SHA1_KEY, code, now, step - 1)).toBe(step);
    });

    it('rechaza formatos que no son 6 dígitos', () => {
      for (const code of ['', '12345', '1234567', 'abcdef', ' 123456']) {
        expect(matchTotp(SHA1_KEY, code, now, null)).toBeNull();
      }
    });
  });

  it('base32 ida y vuelta (RFC 4648)', () => {
    expect(encodeBase32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(decodeBase32('MZXW6YTBOI').toString()).toBe('foobar');
    expect(decodeBase32('mzxw 6ytb-oi======').toString()).toBe('foobar');
    expect(() => decodeBase32('M1')).toThrow();
  });

  it('genera secretos de 160 bits en base32, distintos cada vez', () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(decodeBase32(a)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(a);
  });

  it('otpauth URI con emisor y cuenta codificados', () => {
    expect(totpUri('JBSWY3DPEHPK3PXP', 'ana+1@x.com', 'Dentalix')).toBe(
      'otpauth://totp/Dentalix:ana%2B1%40x.com?secret=JBSWY3DPEHPK3PXP&issuer=Dentalix&algorithm=SHA1&digits=6&period=30',
    );
  });
});
