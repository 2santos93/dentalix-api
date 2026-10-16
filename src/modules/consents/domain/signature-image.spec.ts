import {
  MAX_SIGNATURE_BYTES,
  parseSignaturePng,
  SignatureImageError,
} from './signature-image';

// PNG mínimo válido de 1x1 (firma y cabecera IHDR reales).
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('parseSignaturePng', () => {
  it('acepta un PNG en base64, con o sin prefijo data:', () => {
    expect(parseSignaturePng(TINY_PNG)).toBe(TINY_PNG);
    expect(parseSignaturePng(`data:image/png;base64,${TINY_PNG}`)).toBe(
      TINY_PNG,
    );
  });

  it('rechaza una firma vacía', () => {
    expect(() => parseSignaturePng('')).toThrow(SignatureImageError);
    expect(() => parseSignaturePng('data:image/png;base64,')).toThrow(
      SignatureImageError,
    );
  });

  it('rechaza lo que no es base64', () => {
    expect(() => parseSignaturePng('no es base64!!')).toThrow(/base64/);
  });

  it('rechaza otro tipo de imagen (JPEG) aunque diga image/png', () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]).toString('base64');
    expect(() => parseSignaturePng(`data:image/png;base64,${jpeg}`)).toThrow(
      /PNG/,
    );
  });

  it('rechaza un prefijo data: de otro tipo', () => {
    expect(() =>
      parseSignaturePng(`data:image/jpeg;base64,${TINY_PNG}`),
    ).toThrow(/PNG/);
  });

  it('rechaza una firma de más de 200 KB decodificados', () => {
    const header = Buffer.from(TINY_PNG, 'base64');
    const big = Buffer.concat([
      header,
      Buffer.alloc(MAX_SIGNATURE_BYTES - header.length + 1),
    ]);
    expect(() => parseSignaturePng(big.toString('base64'))).toThrow(/200 KB/);
  });

  it('acepta exactamente el tope', () => {
    const header = Buffer.from(TINY_PNG, 'base64');
    const max = Buffer.concat([
      header,
      Buffer.alloc(MAX_SIGNATURE_BYTES - header.length),
    ]);
    expect(parseSignaturePng(max.toString('base64'))).toBe(
      max.toString('base64'),
    );
  });
});
