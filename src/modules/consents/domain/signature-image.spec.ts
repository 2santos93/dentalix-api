import { deflateSync } from 'node:zlib';
import {
  DEMO_PATIENT_SIGNATURE_PNG,
  DEMO_PROFESSIONAL_SIGNATURE_PNG,
} from '../../../../prisma/demo/signatures';
import {
  MAX_SIGNATURE_BYTES,
  parseSignaturePng,
  SignatureImageError,
} from './signature-image';

// PNG mínimo válido de 1x1 (firma y cabecera IHDR reales).
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * PNG de `width` x `height` con un píxel por llamada a `pixel(x, y)` (bytes
 * de la muestra según `colorType`: 6 = RGBA, 2 = RGB, 4 = gris + alfa).
 */
function png(
  width: number,
  height: number,
  colorType: 2 | 4 | 6,
  pixel: (x: number, y: number) => number[],
  interlace = 0,
): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    // Filtro «Sub» en las filas impares: el decodificador tiene que deshacerlo.
    const filter = y % 2;
    rows.push(filter);
    const raw = Array.from({ length: width }, (_, x) => pixel(x, y)).flat();
    const bpp = raw.length / width;
    raw.forEach((v, i) =>
      rows.push(
        filter === 1 ? (v - (i >= bpp ? raw[i - bpp] : 0) + 256) % 256 : v,
      ),
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

describe('parseSignaturePng', () => {
  describe('contenido: una firma en blanco no vale (DX-012)', () => {
    it('rechaza el lienzo vacío (PNG RGBA totalmente transparente)', () => {
      const blank = png(360, 120, 6, () => [0, 0, 0, 0]);
      expect(() => parseSignaturePng(blank, 'la firma del paciente')).toThrow(
        'La firma del paciente está en blanco: firma en el recuadro.',
      );
    });

    it('rechaza un PNG opaco de un solo color (sin trazo)', () => {
      expect(() =>
        parseSignaturePng(png(50, 20, 2, () => [255, 255, 255])),
      ).toThrow(/en blanco/);
      expect(() => parseSignaturePng(png(50, 20, 4, () => [17, 0]))).toThrow(
        /en blanco/,
      );
    });

    it('acepta un trazo: píxeles con tinta sobre fondo transparente', () => {
      const stroke = png(360, 120, 6, (x, y) =>
        Math.abs(y - 60) < 2 && x > 20 && x < 300
          ? [17, 24, 39, 255]
          : [0, 0, 0, 0],
      );
      expect(parseSignaturePng(stroke)).toBe(stroke);
    });

    it('acepta un RGB con dibujo (no uniforme)', () => {
      const drawn = png(50, 20, 2, (x) =>
        x === 25 ? [0, 0, 0] : [255, 255, 255],
      );
      expect(parseSignaturePng(drawn)).toBe(drawn);
    });

    it('sigue aceptando las firmas de la demo y los PNG de los tests (DX-006)', () => {
      for (const sig of [
        DEMO_PATIENT_SIGNATURE_PNG,
        DEMO_PROFESSIONAL_SIGNATURE_PNG,
        TINY_PNG,
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      ]) {
        expect(parseSignaturePng(sig)).toBe(sig);
      }
    });

    it('rechaza un PNG con los datos de imagen rotos o entrelazado', () => {
      const broken = Buffer.from(TINY_PNG, 'base64');
      broken[41] ^= 0xff; // dentro del IDAT comprimido
      expect(() => parseSignaturePng(broken.toString('base64'))).toThrow(
        'La firma no es una imagen PNG válida.',
      );
      const interlaced = png(8, 8, 6, () => [0, 0, 0, 255], 1);
      expect(() => parseSignaturePng(interlaced)).toThrow(/entrelazar/);
    });
  });

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
