import sharp from 'sharp';
import {
  JPEG_WITH_EXIF,
  makeApng,
  makePng,
  makePngHeader,
  makeWebp,
  pngChunk,
} from '../__fixtures__/logo-fixtures';
import {
  LOGO_MESSAGES,
  LOGO_OUTPUT_MAX_SIDE,
  sanitizeLogo,
  type SanitizedLogo,
} from '../domain/logo-image';
import { SharpLogoImageCodec } from './sharp-logo-image-codec';

// DX-019-bis: el logo se DECODIFICA y se vuelve a codificar con libvips
// (sharp). Imágenes reales generadas aquí; la salida se vuelve a decodificar
// para comprobar formato, tamaño, píxeles y que no quedan metadatos.

const codec = new SharpLogoImageCodec();

async function ok(bytes: Buffer) {
  const result: SanitizedLogo = await sanitizeLogo(bytes, codec);
  if (!result.ok) throw new Error(`esperaba ok, fue: ${result.message}`);
  return result;
}

const rejected = (message: string) => ({ ok: false, message });

/** Color RGBA del píxel (x, y) de una imagen. */
async function pixel(bytes: Buffer, x = 0, y = 0) {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [...data.subarray(i, i + 4)];
}

/** JPEG `width` × `height`: mitad izquierda roja, mitad derecha azul. */
function halves(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: '#ff0000' },
  }).composite([
    {
      input: {
        create: {
          width: width / 2,
          height,
          channels: 3,
          background: '#0000ff',
        },
      },
      left: width / 2,
      top: 0,
    },
  ]);
}

describe('SharpLogoImageCodec (DX-019-bis)', () => {
  it('PNG con transparencia: sigue PNG, con alfa y los mismos píxeles', async () => {
    const png = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 4,
        background: { r: 14, g: 116, b: 144, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const out = await ok(png);
    expect(out.contentType).toBe('image/png');
    const meta = await sharp(out.bytes).metadata();
    expect(meta).toMatchObject({
      format: 'png',
      width: 40,
      height: 20,
      hasAlpha: true,
    });
    expect(await pixel(out.bytes)).toEqual([14, 116, 144, 128]);
  });

  it('JPEG con EXIF de orientación 6: sale girado, JPEG y sin EXIF', async () => {
    // 40×20 en disco; la orientación 6 dice «gíralo 90° a la derecha».
    const jpeg = await halves(40, 20)
      .jpeg({ quality: 100 })
      .withExif({ IFD0: { Copyright: 'Clínica Caracas' } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).orientation).toBe(6);
    const out = await ok(jpeg);
    expect(out.contentType).toBe('image/jpeg');
    const meta = await sharp(out.bytes).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 20, height: 40 });
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(out.bytes.includes(Buffer.from('Exif'))).toBe(false);
    expect(out.bytes.includes(Buffer.from('Caracas'))).toBe(false);
    // Girado a la derecha: lo que estaba a la izquierda (rojo) queda arriba.
    const [r, , b] = await pixel(out.bytes, 10, 2);
    expect(r).toBeGreaterThan(200);
    expect(b).toBeLessThan(60);
  });

  it('el JPEG de una cámara (JFIF + EXIF) se re-codifica sin EXIF', async () => {
    const out = await ok(JPEG_WITH_EXIF);
    expect(out.contentType).toBe('image/jpeg');
    expect(out.bytes.includes(Buffer.from('Exif'))).toBe(false);
    expect(await sharp(out.bytes).metadata()).toMatchObject({
      format: 'jpeg',
      width: 4,
      height: 4,
    });
  });

  it('WebP → PNG, conservando la transparencia', async () => {
    const out = await ok(await makeWebp(30, 10, { alpha: 0.5 }));
    expect(out.contentType).toBe('image/png');
    expect(await sharp(out.bytes).metadata()).toMatchObject({
      format: 'png',
      width: 30,
      height: 10,
      hasAlpha: true,
    });
    expect(await pixel(out.bytes)).toEqual([14, 116, 144, 128]);
  });

  it('WebP animado: queda estático, solo el primer fotograma', async () => {
    const frame = (background: string) =>
      sharp({ create: { width: 20, height: 20, channels: 4, background } })
        .png()
        .toBuffer();
    const animated = await sharp(
      [await frame('#00ff00'), await frame('#0000ff')],
      { join: { animated: true } },
    )
      .webp({ lossless: true })
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    const out = await ok(animated);
    const meta = await sharp(out.bytes, { animated: true }).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 20, height: 20 });
    expect(meta.pages ?? 1).toBe(1);
    expect(await pixel(out.bytes)).toEqual([0, 255, 0, 255]);
  });

  it('APNG: queda estático, solo el primer fotograma, sin trozos de animación', async () => {
    const out = await ok(makeApng(6, 6));
    expect(await sharp(out.bytes).metadata()).toMatchObject({
      format: 'png',
      width: 6,
      height: 6,
    });
    for (const type of ['acTL', 'fcTL', 'fdAT'])
      expect(out.bytes.includes(Buffer.from(type))).toBe(false);
    expect((await pixel(out.bytes)).slice(0, 3)).toEqual([255, 0, 0]);
  });

  it('metadatos (tEXt, EXIF, XMP) y lo pegado tras el final (políglota) no llegan', async () => {
    const png = makePng(8, 8, {
      before: [
        pngChunk('tEXt', Buffer.from('Comment\0<script>alert(1)</script>')),
      ],
      after: Buffer.from('<html><script>alert(1)</script></html>'),
    });
    const pngOut = await ok(png);
    expect(pngOut.bytes.includes(Buffer.from('script'))).toBe(false);
    expect(pngOut.bytes.includes(Buffer.from('tEXt'))).toBe(false);

    const xmp =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description>GPS 10.4806 -66.9036</rdf:Description></rdf:RDF></x:xmpmeta>';
    const webp = await sharp(await makeWebp(8, 8, { exif: 'GPS Caracas' }))
      .withXmp(xmp)
      .webp({ lossless: true })
      .toBuffer();
    expect(webp.includes(Buffer.from('GPS'))).toBe(true);
    const webpOut = await ok(webp);
    const meta = await sharp(webpOut.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(webpOut.bytes.includes(Buffer.from('GPS'))).toBe(false);
  });

  it('un perfil de color que no es sRGB (Display P3) se convierte y no se guarda', async () => {
    const p3 = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#0e7490' },
    })
      .withIccProfile('p3')
      .png()
      .toBuffer();
    expect((await sharp(p3).metadata()).icc).toBeDefined();
    const out = await ok(p3);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.icc).toBeUndefined();
    expect(meta.space).toBe('srgb');
    expect(out.bytes.includes(Buffer.from('iCCP'))).toBe(false);
  });

  it('3000 px de ancho: se reduce a 1024 manteniendo la proporción; uno pequeño no se agranda', async () => {
    const big = await sharp({
      create: { width: 3000, height: 1500, channels: 3, background: '#0e7490' },
    })
      .png()
      .toBuffer();
    const out = await ok(big);
    expect(await sharp(out.bytes).metadata()).toMatchObject({
      width: LOGO_OUTPUT_MAX_SIDE,
      height: 512,
    });
    const small = await ok(makePng(8, 4));
    expect(await sharp(small.bytes).metadata()).toMatchObject({
      width: 8,
      height: 4,
    });
  });

  it('5000 × 10: rechazado por tamaño (lado máximo 4096)', async () => {
    const wide = await sharp({
      create: { width: 5000, height: 10, channels: 3, background: '#0e7490' },
    })
      .webp({ lossless: true })
      .toBuffer();
    expect(await sanitizeLogo(wide, codec)).toEqual(
      rejected(LOGO_MESSAGES.dimensions),
    );
  });

  it('bomba (la cabecera dice 100 000 × 100 000): rechazada sin decodificar', async () => {
    const before = process.memoryUsage().rss;
    expect(await sanitizeLogo(makePngHeader(100_000, 100_000), codec)).toEqual(
      rejected(LOGO_MESSAGES.dimensions),
    );
    // 10¹⁰ píxeles serían decenas de GB: no se reservó nada parecido.
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
  });

  it('bytes truncados o cuerpo que no decodifica: dañado', async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#0e7490' },
    })
      .png()
      .toBuffer();
    const jpeg = await halves(64, 64).jpeg().toBuffer();
    const webp = await makeWebp(64, 64);
    const badCrc = makePng();
    badCrc[30] ^= 0xff;
    // IDAT con CRC correcto pero que no es deflate.
    const notDeflate = Buffer.concat([
      makePng(4, 4).subarray(0, 33),
      pngChunk('IDAT', Buffer.from('no es deflate, es basura')),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    // WebP con contenedor correcto y bitstream VP8L de relleno.
    const fakeVp8l = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([18, 0, 0, 0]),
      Buffer.from('WEBPVP8L'),
      Buffer.from([5, 0, 0, 0, 0x2f, 0, 0, 0, 0x10, 0]),
    ]);
    for (const bytes of [
      png.subarray(0, png.length - 40),
      png.subarray(0, 40),
      jpeg.subarray(0, jpeg.length - 100),
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      webp.subarray(0, webp.length - 10),
      badCrc,
      notDeflate,
      fakeVp8l,
    ]) {
      expect(await sanitizeLogo(bytes, codec)).toEqual(
        rejected(LOGO_MESSAGES.damaged),
      );
    }
  });

  it('un tipo que no coincide con lo que dice el sniff: dañado', async () => {
    const result = await codec.reencode(makePng(), {
      input: 'image/jpeg',
      output: 'image/jpeg',
    });
    expect(result).toEqual({ ok: false, reason: 'damaged' });
  });
});
