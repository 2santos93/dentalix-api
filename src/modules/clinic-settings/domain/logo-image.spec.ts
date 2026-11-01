import {
  JPEG_WITH_EXIF,
  SIMPLE_SVG,
  makePng,
  pngChunk,
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

function svgOut(svg: string): string {
  return ok(Buffer.from(svg, 'utf8')).bytes.toString('utf8');
}

describe('logo de la clínica (DX-019)', () => {
  describe('tipo por los bytes, no por la etiqueta', () => {
    it('reconoce PNG, JPEG y SVG', () => {
      expect(sniffLogo(makePng())).toBe('image/png');
      expect(sniffLogo(JPEG_WITH_EXIF)).toBe('image/jpeg');
      expect(sniffLogo(SIMPLE_SVG)).toBe('image/svg+xml');
      expect(sniffLogo(Buffer.from('\uFEFF  <svg viewBox="0 0 1 1"/>'))).toBe(
        'image/svg+xml',
      );
    });

    it('rechaza HTML, GIF, WebP, PDF y texto con un mensaje claro', () => {
      for (const bytes of [
        Buffer.from('<html><script>alert(1)</script></html>'),
        Buffer.from('GIF89a\x01\x00\x01\x00'),
        Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 '),
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

  describe('SVG saneado', () => {
    it('un dibujo sencillo se conserva', () => {
      const out = ok(SIMPLE_SVG);
      expect(out.contentType).toBe('image/svg+xml');
      expect(out.bytes.toString()).toBe(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="#0E7490"/></svg>',
      );
    });

    it('se caen scripts, eventos, foreignObject, imágenes, enlaces y animaciones con su contenido', () => {
      const out = svgOut(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">' +
          '<script>alert(1)</script>' +
          '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>' +
          '<image href="https://tracker.example/x.png"/>' +
          '<a href="javascript:alert(1)"><rect width="1" height="1"/></a>' +
          '<rect width="2" height="2" onclick="alert(1)"><set attributeName="fill" to="red"/></rect>' +
          '</svg>',
      );
      expect(out).not.toMatch(
        /script|alert|foreignObject|image|tracker|javascript|onload|onclick|<a|<set|xhtml/,
      );
      expect(out).toContain('<rect width="2" height="2"></rect>');
    });

    it('href solo hacia #id del propio dibujo; url() externo fuera', () => {
      const out = svgOut(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
          '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
          '<use xlink:href="#g"/><use href="https://evil.example/a.svg#x"/>' +
          '<rect fill="url(#g)" width="1" height="1"/>' +
          '<rect fill="url(https://evil.example/p)" style="fill:url(https://evil.example/p)" width="1" height="1"/>' +
          '</svg>',
      );
      expect(out).toContain('<use xlink:href="#g"/>');
      expect(out).toContain('fill="url(#g)"');
      expect(out).not.toContain('evil.example');
    });

    it('CSS: un <style> sencillo se queda; con @import, escapes o url externa, rechazado', () => {
      expect(
        svgOut(
          '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:#123456}</style><rect class="a"/></svg>',
        ),
      ).toContain('<style>.a{fill:#123456}</style><rect class="a"/>');
      expect(
        svgOut(
          '<svg xmlns="http://www.w3.org/2000/svg"><defs><style><![CDATA[.a>b{fill:red}]]></style></defs></svg>',
        ),
      ).toContain('<style>.a&gt;b{fill:red}</style>');
      for (const css of [
        '@import url(https://x.example/a.css);',
        '.a{background:\\75rl(x)}',
        '.a{fill:url(https://x.example/)}',
      ]) {
        expect(
          sanitizeLogo(
            Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style></svg>`,
            ),
          ),
        ).toEqual({
          ok: false,
          message: LOGO_MESSAGES.svg,
        });
      }
    });

    it('DOCTYPE, entidades propias, CDATA suelto, instrucciones y XML mal formado: rechazados', () => {
      for (const svg of [
        '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><text>&nbsp;</text></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><text><![CDATA[x]]></text></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><?php echo 1; ?></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"></svg><svg/>',
        '<html><svg/></html>',
        '<svg xmlns="http://www.w3.org/2000/svg"><text>a & b</text></svg>',
      ]) {
        const result = sanitizeLogo(Buffer.from(svg));
        expect(result.ok).toBe(false);
      }
    });

    it('el texto se re-escapa (no se puede abrir una etiqueta desde un texto)', () => {
      expect(
        svgOut(
          '<svg xmlns="http://www.w3.org/2000/svg"><text>&lt;script&gt; &#65;&#x42;</text></svg>',
        ),
      ).toContain('<text>&lt;script&gt; AB</text>');
    });

    it('elementos de editores (sodipodi, inkscape, metadata) se caen con su contenido', () => {
      const out = svgOut(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="x" inkscape:version="1"><metadata><rdf:RDF/></metadata>' +
          '<sodipodi:namedview pagecolor="#fff"/><path d="M0 0h1" inkscape:label="a"/></svg>',
      );
      expect(out).toBe(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><path d="M0 0h1"/></svg>',
      );
    });
  });
});
