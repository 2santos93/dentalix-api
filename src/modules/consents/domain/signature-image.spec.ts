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
import {
  noise,
  pngAllFilters,
  pngBombBase64,
  pngFromRaw,
  pngLyingBombBase64,
  signaturePng,
} from '../../../../test/support/png-fixtures';

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

  describe('bombas de descompresión y dimensiones (SEC-026)', () => {
    const elapsedMs = (fn: () => void): number => {
      const start = process.hrtime.bigint();
      fn();
      return Number(process.hrtime.bigint() - start) / 1e6;
    };

    it('rechaza rápido la bomba del auditor (IHDR 10000x5000, IDAT de 200 MB)', () => {
      const bomb = pngBombBase64();
      // Cabe bajo el tope de 200 KB: el tope de bytes no la paraba.
      expect(Buffer.from(bomb, 'base64').length).toBeLessThan(
        MAX_SIGNATURE_BYTES,
      );
      let error: unknown;
      const ms = elapsedMs(() => {
        try {
          parseSignaturePng(bomb, 'la firma del paciente');
        } catch (e) {
          error = e;
        }
      });
      expect(error).toBeInstanceOf(SignatureImageError);
      expect((error as Error).message).toBe(
        'La firma del paciente tiene unas dimensiones no válidas (máximo 4096 x 1024 píxeles).',
      );
      expect(ms).toBeLessThan(50);
    });

    it('rechaza rápido un PNG cuyo IDAT infla más de lo que dice su cabecera', () => {
      const bomb = pngLyingBombBase64();
      expect(Buffer.from(bomb, 'base64').length).toBeLessThan(
        MAX_SIGNATURE_BYTES,
      );
      let error: unknown;
      const ms = elapsedMs(() => {
        try {
          parseSignaturePng(bomb);
        } catch (e) {
          error = e;
        }
      });
      expect(error).toBeInstanceOf(SignatureImageError);
      expect((error as Error).message).toBe(
        'La firma no es una imagen PNG válida.',
      );
      expect(ms).toBeLessThan(50);
    });

    it.each([
      ['ancho de más', 4097, 10],
      ['alto de más', 100, 1025],
      ['área de más (4096 x 1000 > 4 000 000)', 4096, 1000],
      ['ancho cero', 0, 10],
      ['alto cero', 10, 0],
    ])('rechaza dimensiones fuera de rango antes de inflar: %s', (_, w, h) => {
      // El IDAT es de 1x1: si se llegara a inflar, el error sería otro.
      const fake = pngFromRaw(w, h, Buffer.from([0, 0, 0, 0, 255]));
      expect(() => parseSignaturePng(fake.toString('base64'))).toThrow(
        'La firma tiene unas dimensiones no válidas (máximo 4096 x 1024 píxeles).',
      );
    });

    it('rechaza una profundidad de bits que no corresponde al tipo de color', () => {
      const odd = pngFromRaw(1, 1, Buffer.from([0, 0, 0, 0, 255]), {
        colorType: 6,
        bitDepth: 4,
      });
      expect(() => parseSignaturePng(odd.toString('base64'))).toThrow(
        'La firma no es una imagen PNG válida.',
      );
    });

    it.each([
      // Lienzo de la web: alto 160 px CSS a 2x (MAX_PIXEL_RATIO) = 320.
      ['escritorio ancho (1200 px CSS a 2x)', 2400, 320],
      ['móvil (430 px CSS a 2x)', 860, 320],
      // Por si algún día se quita el tope de 2x: un móvil a 3x.
      ['móvil a 3x sin tope (430 x 160 px CSS)', 1290, 480],
      ['en el límite de área (4000 x 1000)', 4000, 1000],
      ['en el límite de ancho y alto (4096 x 976)', 4096, 976],
    ])('acepta una firma real: %s', (_, w, h) => {
      const sig = signaturePng(w, h).toString('base64');
      expect(Buffer.from(sig, 'base64').length).toBeLessThan(
        MAX_SIGNATURE_BYTES,
      );
      expect(parseSignaturePng(sig)).toBe(sig);
    });

    it('encuentra la tinta aunque solo esté en la primera o en la última fila', () => {
      for (const row of [0, 319]) {
        const sig = signaturePng(2400, 320, row).toString('base64');
        expect(parseSignaturePng(sig)).toBe(sig);
      }
    });

    it('sigue rechazando un lienzo en blanco del tamaño real', () => {
      const blank = pngFromRaw(2400, 320, Buffer.alloc(320 * (2400 * 4 + 1)));
      expect(() => parseSignaturePng(blank.toString('base64'))).toThrow(
        'La firma está en blanco: firma en el recuadro.',
      );
    });

    it('deshace los cinco filtros: alfa con ruido por debajo del umbral sigue en blanco', () => {
      // Alfa aleatorio entre 0 y 15 (bajo MIN_INK_ALPHA) y color con ruido:
      // si un filtro se deshiciera mal, saldrían alfas ≥ 16 («tinta»).
      for (const [colorType, bpp] of [
        [6, 4],
        [4, 2],
      ]) {
        const pixels = noise(60 * 40 * bpp);
        for (let i = bpp - 1; i < pixels.length; i += bpp) pixels[i] &= 0x0f;
        const blank = pngAllFilters(60, 40, pixels, { colorType });
        expect(() => parseSignaturePng(blank.toString('base64'))).toThrow(
          /en blanco/,
        );
        // Un solo píxel con tinta en una fila con Paeth (y % 5 === 4).
        pixels[(34 * 60 + 33) * bpp + bpp - 1] = 200;
        const inked = pngAllFilters(60, 40, pixels, { colorType });
        expect(parseSignaturePng(inked.toString('base64'))).toBe(
          inked.toString('base64'),
        );
      }
    });

    it('deshace los cinco filtros sin alfa: uniforme en blanco, un píxel distinto vale', () => {
      const pixels = Buffer.alloc(60 * 40 * 3, 255);
      const blank = pngAllFilters(60, 40, pixels, { colorType: 2 });
      expect(() => parseSignaturePng(blank.toString('base64'))).toThrow(
        /en blanco/,
      );
      pixels[(39 * 60 + 59) * 3 + 2] = 0; // último píxel, fila con Paeth
      const drawn = pngAllFilters(60, 40, pixels, { colorType: 2 });
      expect(parseSignaturePng(drawn.toString('base64'))).toBe(
        drawn.toString('base64'),
      );
    });

    it('rechaza sin inflar un PNG pesado para su área (16 bits o sin alfa muy grande)', () => {
      const tiny = Buffer.from([0, 0, 0, 0, 255]);
      for (const [w, h, colorType, bitDepth] of [
        [4096, 976, 2, 8], // RGB: 12 MB a deshacer entero
        [4096, 976, 6, 16], // RGBA de 16 bits: 32 MB inflados
        [2600, 1000, 0, 16], // gris de 16 bits: 5,2 MB a deshacer
      ]) {
        const heavy = pngFromRaw(w, h, tiny, { colorType, bitDepth });
        expect(() => parseSignaturePng(heavy.toString('base64'))).toThrow(
          'La firma es una imagen demasiado pesada: usa un PNG de 8 bits con transparencia.',
        );
      }
      // Pequeños, esos mismos formatos siguen valiendo.
      const rgba16 = pngAllFilters(20, 10, noise(20 * 10 * 8), {
        colorType: 6,
        bitDepth: 16,
      });
      expect(parseSignaturePng(rgba16.toString('base64'))).toBe(
        rgba16.toString('base64'),
      );
    });

    it('rechaza un IDAT que se queda corto o un filtro desconocido tras la tinta', () => {
      const short = pngFromRaw(10, 10, Buffer.from([0, 0, 0, 0, 255]));
      expect(() => parseSignaturePng(short.toString('base64'))).toThrow(
        'La firma no es una imagen PNG válida.',
      );
      const raw = Buffer.alloc(2 * (4 + 1));
      raw[4] = 255; // tinta en la fila 0
      raw[5] = 9; // filtro inexistente en la fila 1
      expect(() =>
        parseSignaturePng(pngFromRaw(1, 2, raw).toString('base64')),
      ).toThrow('La firma no es una imagen PNG válida.');
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
