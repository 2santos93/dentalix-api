import {
  JPEG_WITH_EXIF,
  SVG_WITH_SCRIPT,
  makePng,
  makeWebp,
} from '../__fixtures__/logo-fixtures';
import {
  LOGO_MAX_BYTES,
  LOGO_MESSAGES,
  LOGO_OUTPUT_TYPE,
  sanitizeLogo,
  sniffLogo,
} from './logo-image';
import type {
  LogoImageCodec,
  LogoReencodeResult,
} from './ports/logo-image-codec.port';

/** Codec de mentira: apunta lo que le llega y responde lo que se le diga. */
function fakeCodec(
  result: LogoReencodeResult = { ok: true, bytes: Buffer.from('limpio') },
) {
  const calls: { bytes: Buffer; input: string; output: string }[] = [];
  const codec: LogoImageCodec = {
    reencode: (bytes, types) => {
      calls.push({ bytes, ...types });
      return Promise.resolve(result);
    },
  };
  return { codec, calls };
}

describe('logo de la clínica (DX-019, DX-019-bis)', () => {
  describe('tipo por los bytes, no por la etiqueta', () => {
    it('reconoce PNG, JPEG y WebP', async () => {
      expect(sniffLogo(makePng())).toBe('image/png');
      expect(sniffLogo(JPEG_WITH_EXIF)).toBe('image/jpeg');
      expect(sniffLogo(await makeWebp())).toBe('image/webp');
    });

    it('rechaza HTML, GIF, TIFF, PDF y texto con un mensaje claro, sin llegar al codec', async () => {
      const { codec, calls } = fakeCodec();
      for (const bytes of [
        Buffer.from('<html><script>alert(1)</script></html>'),
        Buffer.from('GIF89a\x01\x00\x01\x00'),
        Buffer.from('II*\x00\x08\x00\x00\x00'),
        Buffer.from('%PDF-1.7'),
        Buffer.from('hola'),
      ]) {
        expect(await sanitizeLogo(bytes, codec)).toEqual({
          ok: false,
          message: LOGO_MESSAGES.type,
        });
      }
      expect(calls).toHaveLength(0);
    });

    it('vacío y de más de 1 MB: rechazados sin llegar al codec', async () => {
      const { codec, calls } = fakeCodec();
      expect(await sanitizeLogo(Buffer.alloc(0), codec)).toEqual({
        ok: false,
        message: LOGO_MESSAGES.empty,
      });
      const big = Buffer.concat([makePng(), Buffer.alloc(LOGO_MAX_BYTES)]);
      expect(await sanitizeLogo(big, codec)).toEqual({
        ok: false,
        message: LOGO_MESSAGES.tooLarge,
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('SVG: nunca (ni siquiera llega a libvips)', () => {
    it('un SVG con script se rechaza, con cualquier cabecera delante', async () => {
      const { codec, calls } = fakeCodec();
      for (const bytes of [
        SVG_WITH_SCRIPT,
        Buffer.concat([
          Buffer.from('<?xml version="1.0"?>\n'),
          SVG_WITH_SCRIPT,
        ]),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), SVG_WITH_SCRIPT]),
      ]) {
        expect(sniffLogo(bytes)).toBeNull();
        expect(await sanitizeLogo(bytes, codec)).toEqual({
          ok: false,
          message: LOGO_MESSAGES.type,
        });
      }
      expect(calls).toHaveLength(0);
    });
  });

  describe('re-codificación (D2: PNG→PNG, JPEG→JPEG, WebP→PNG)', () => {
    it('el tipo guardado es el de la SALIDA, no el de la entrada', async () => {
      expect(LOGO_OUTPUT_TYPE).toEqual({
        'image/png': 'image/png',
        'image/jpeg': 'image/jpeg',
        'image/webp': 'image/png',
      });
      const webp = await makeWebp();
      const { codec, calls } = fakeCodec();
      expect(await sanitizeLogo(webp, codec)).toEqual({
        ok: true,
        contentType: 'image/png',
        bytes: Buffer.from('limpio'),
      });
      expect(calls).toEqual([
        { bytes: webp, input: 'image/webp', output: 'image/png' },
      ]);
    });

    it('lo que no decodifica o pasa de los topes: el mensaje en español, nunca el de libvips', async () => {
      expect(
        await sanitizeLogo(
          makePng(),
          fakeCodec({ ok: false, reason: 'damaged' }).codec,
        ),
      ).toEqual({ ok: false, message: LOGO_MESSAGES.damaged });
      expect(
        await sanitizeLogo(
          makePng(),
          fakeCodec({ ok: false, reason: 'dimensions' }).codec,
        ),
      ).toEqual({ ok: false, message: LOGO_MESSAGES.dimensions });
    });

    it('si el codec lanza, es «dañado» (sin detalles internos)', async () => {
      const codec: LogoImageCodec = {
        reencode: () => Promise.reject(new Error('VipsJpeg: libvips interno')),
      };
      expect(await sanitizeLogo(JPEG_WITH_EXIF, codec)).toEqual({
        ok: false,
        message: LOGO_MESSAGES.damaged,
      });
    });

    it('una salida de más de 1 MB se rechaza por tamaño', async () => {
      const { codec } = fakeCodec({
        ok: true,
        bytes: Buffer.alloc(LOGO_MAX_BYTES + 1),
      });
      expect(await sanitizeLogo(makePng(), codec)).toEqual({
        ok: false,
        message: LOGO_MESSAGES.tooLarge,
      });
    });
  });
});
