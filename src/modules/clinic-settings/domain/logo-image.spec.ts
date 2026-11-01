import {
  JPEG_WITH_EXIF,
  SVG_WITH_SCRIPT,
  makePng,
  makeWebp,
  pngChunk,
  webpChunk,
} from '../__fixtures__/logo-fixtures';
import {
  LOGO_MAX_BYTES,
  LOGO_MESSAGES,
  sanitizeLogo,
  sniffLogo,
} from './logo-image';

function ok(bytes: Buffer) {
  const result = sanitizeLogo(bytes);
  if (!result.ok) throw new Error(`esperaba ok, fue: ${result.message}`);
  return result;
}

describe('logo de la clínica (DX-019)', () => {
  describe('tipo por los bytes, no por la etiqueta', () => {
    it('reconoce PNG, JPEG y WebP', () => {
      expect(sniffLogo(makePng())).toBe('image/png');
      expect(sniffLogo(JPEG_WITH_EXIF)).toBe('image/jpeg');
      expect(sniffLogo(makeWebp())).toBe('image/webp');
    });

    it('rechaza HTML, GIF, PDF y texto con un mensaje claro', () => {
      for (const bytes of [
        Buffer.from('<html><script>alert(1)</script></html>'),
        Buffer.from('GIF89a\x01\x00\x01\x00'),
        Buffer.from('%PDF-1.7'),
        Buffer.from('hola'),
      ]) {
        expect(sanitizeLogo(bytes)).toEqual({
          ok: false,
          message: LOGO_MESSAGES.type,
        });
      }
    });

    it('vacío y de más de 1 MB: rechazados', () => {
      expect(sanitizeLogo(Buffer.alloc(0))).toEqual({
        ok: false,
        message: LOGO_MESSAGES.empty,
      });
      const big = Buffer.concat([makePng(), Buffer.alloc(LOGO_MAX_BYTES)]);
      expect(sanitizeLogo(big)).toEqual({
        ok: false,
        message: LOGO_MESSAGES.tooLarge,
      });
    });
  });

  describe('PNG re-escrito', () => {
    it('una imagen limpia sale idéntica', () => {
      const png = makePng();
      const out = ok(png);
      expect(out.contentType).toBe('image/png');
      expect(out.bytes.equals(png)).toBe(true);
    });

    it('se caen los metadatos (tEXt, eXIf) y lo pegado detrás del final (políglota)', () => {
      const text = pngChunk(
        'tEXt',
        Buffer.from('Comment\0<script>alert(1)</script>'),
      );
      const exif = pngChunk('eXIf', Buffer.from('MM\0*GPS'));
      const payload = Buffer.from('<html><script>alert(1)</script></html>');
      const out = ok(
        makePng(4, 4, { before: [text, exif], after: payload }),
      ).bytes;
      expect(out.equals(makePng())).toBe(true);
      expect(out.includes(Buffer.from('script'))).toBe(false);
    });

    it('CRC roto, sin IDAT, sin IEND o truncado: dañado', () => {
      const png = makePng();
      const badCrc = Buffer.from(png);
      badCrc[30] ^= 0xff;
      expect(sanitizeLogo(badCrc)).toEqual({
        ok: false,
        message: LOGO_MESSAGES.damaged,
      });
      expect(sanitizeLogo(png.subarray(0, png.length - 12))).toEqual({
        ok: false,
        message: LOGO_MESSAGES.damaged,
      });
      expect(sanitizeLogo(png.subarray(0, 40))).toEqual({
        ok: false,
        message: LOGO_MESSAGES.damaged,
      });
    });

    it('un trozo crítico desconocido no se puede saltar: dañado', () => {
      const weird = pngChunk('ZZZZ', Buffer.from('x'));
      expect(sanitizeLogo(makePng(4, 4, { before: [weird] }))).toEqual({
        ok: false,
        message: LOGO_MESSAGES.damaged,
      });
    });

    it('más de 8192 px de lado: rechazado por tamaño', () => {
      const png = makePng(1, 1);
      png.writeUInt32BE(9000, 16);
      // El CRC del IHDR se rehace para que lo único mal sea el lado.
      const fixed = Buffer.concat([
        png.subarray(0, 8),
        pngChunk('IHDR', png.subarray(16, 29)),
        png.subarray(33),
      ]);
      expect(sanitizeLogo(fixed)).toEqual({
        ok: false,
        message: LOGO_MESSAGES.dimensions,
      });
    });
  });

  describe('JPEG re-escrito', () => {
    it('se cae el EXIF (APP1) y se conserva JFIF; la imagen sigue entera', () => {
      const out = ok(JPEG_WITH_EXIF);
      expect(out.contentType).toBe('image/jpeg');
      expect(JPEG_WITH_EXIF.includes(Buffer.from('Exif'))).toBe(true);
      expect(out.bytes.includes(Buffer.from('Exif'))).toBe(false);
      expect(out.bytes.includes(Buffer.from('JFIF'))).toBe(true);
      expect(out.bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(out.bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
      // Re-escribir lo re-escrito no cambia nada (es estable).
      expect(ok(out.bytes).bytes.equals(out.bytes)).toBe(true);
    });

    it('lo pegado detrás de EOI y los comentarios no llegan', () => {
      const comment = Buffer.concat([
        Buffer.from([0xff, 0xfe, 0x00, 0x0a]),
        Buffer.from('<script>'),
      ]);
      const withComment = Buffer.concat([
        JPEG_WITH_EXIF.subarray(0, 2),
        comment,
        JPEG_WITH_EXIF.subarray(2),
        Buffer.from('<html><script>alert(1)</script>'),
      ]);
      const out = ok(withComment).bytes;
      expect(out.includes(Buffer.from('script'))).toBe(false);
      expect(out.equals(ok(JPEG_WITH_EXIF).bytes)).toBe(true);
    });

    it('truncado o sin barrido: dañado', () => {
      expect(sanitizeLogo(JPEG_WITH_EXIF.subarray(0, 200))).toEqual({
        ok: false,
        message: LOGO_MESSAGES.damaged,
      });
      expect(sanitizeLogo(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toEqual({
        ok: false,
        message: LOGO_MESSAGES.damaged,
      });
    });
  });

  describe('WebP re-escrito', () => {
    it('una imagen limpia sale idéntica', () => {
      const webp = makeWebp();
      const out = ok(webp);
      expect(out.contentType).toBe('image/webp');
      expect(out.bytes.equals(webp)).toBe(true);
    });

    it('se caen EXIF, XMP y lo pegado detrás del RIFF', () => {
      const dirty = Buffer.concat([
        makeWebp([
          webpChunk('EXIF', Buffer.from('MM<script>')),
          webpChunk('XMP ', Buffer.from('<x:script/>')),
        ]),
        Buffer.from('<html><script>alert(1)</script>'),
      ]);
      const out = ok(dirty).bytes;
      expect(out.includes(Buffer.from('script'))).toBe(false);
      expect(out.equals(makeWebp())).toBe(true);
    });

    it('un RIFF truncado o sin imagen: dañado', () => {
      const webp = makeWebp();
      expect(sanitizeLogo(webp.subarray(0, webp.length - 2))).toEqual({
        ok: false,
        message: LOGO_MESSAGES.damaged,
      });
      const empty = Buffer.from(webp);
      empty.writeUInt32LE(4, 4);
      expect(sanitizeLogo(empty)).toEqual({
        ok: false,
        message: LOGO_MESSAGES.damaged,
      });
    });
  });

  describe('SVG: nunca', () => {
    it('un SVG con script se rechaza, con cualquier cabecera delante', () => {
      for (const bytes of [
        SVG_WITH_SCRIPT,
        Buffer.concat([
          Buffer.from('<?xml version="1.0"?>\n'),
          SVG_WITH_SCRIPT,
        ]),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), SVG_WITH_SCRIPT]),
      ]) {
        expect(sniffLogo(bytes)).toBeNull();
        expect(sanitizeLogo(bytes)).toEqual({
          ok: false,
          message: LOGO_MESSAGES.type,
        });
      }
    });
  });
});
