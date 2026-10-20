import { contentDispositionHeader } from './file-storage.port';
import { contentTypeOf, isServableContentType } from './content-type';

// DX-151: cabecera Content-Disposition de las URL firmadas (RFC 6266 con el
// `filename*` de RFC 5987 para los nombres que no son ASCII).
describe('contentDispositionHeader (DX-151)', () => {
  it('nombre con ñ: fallback ASCII + filename* en UTF-8 codificado', () => {
    expect(
      contentDispositionHeader({
        disposition: 'inline',
        filename: 'radio ñ.pdf',
      }),
    ).toBe(
      `inline; filename="radio n.pdf"; filename*=UTF-8''radio%20%C3%B1.pdf`,
    );
  });

  it('sin nombre: solo la disposición', () => {
    expect(contentDispositionHeader({ disposition: 'attachment' })).toBe(
      'attachment',
    );
  });

  it('quita comillas, barras invertidas y saltos de línea (sin inyectar cabeceras)', () => {
    const header = contentDispositionHeader({
      disposition: 'attachment',
      filename: 'mi "informe"\\\r\nSet-Cookie: x=1.pdf',
    });
    expect(header).toBe(
      `attachment; filename="mi informeSet-Cookie: x=1.pdf"; filename*=UTF-8''mi%20informeSet-Cookie%3A%20x%3D1.pdf`,
    );
    expect(header).not.toMatch(/[\r\n\\]/);
  });

  it("codifica ' ( ) * en filename* (no son attr-char de RFC 5987)", () => {
    expect(
      contentDispositionHeader({
        disposition: 'inline',
        filename: "o'brien (1)*.pdf",
      }),
    ).toBe(
      `inline; filename="o'brien (1)*.pdf"; filename*=UTF-8''o%27brien%20%281%29%2A.pdf`,
    );
  });

  it('lo que no es latino pasa a _ en el fallback y va entero en filename*', () => {
    expect(
      contentDispositionHeader({ disposition: 'inline', filename: '报告.pdf' }),
    ).toBe(
      `inline; filename="__.pdf"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf`,
    );
  });

  it('recorta a 255 caracteres conservando la extensión', () => {
    const header = contentDispositionHeader({
      disposition: 'attachment',
      filename: `${'a'.repeat(300)}.pdf`,
    });
    const fallback = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
    expect(fallback).toHaveLength(255);
    expect(fallback.endsWith('.pdf')).toBe(true);
  });

  it('comilla y barra invertida de ancho completo (U+FF02, U+FF3C) no rompen el fallback', () => {
    const header = contentDispositionHeader({
      disposition: 'attachment',
      filename: 'a＂; filename=＂evil.exe',
    });
    expect(header).toBe(
      `attachment; filename="a_; filename=_evil.exe"; filename*=UTF-8''a%EF%BC%82%3B%20filename%3D%EF%BC%82evil.exe`,
    );
    expect(header.match(/"/g)).toHaveLength(2);
    expect(
      contentDispositionHeader({ disposition: 'inline', filename: 'a＼b.pdf' }),
    ).toBe(`inline; filename="a_b.pdf"; filename*=UTF-8''a%EF%BC%BCb.pdf`);
  });

  it('el fallback no pasa de 255 aunque NFKD expanda (U+FDFA → 18 caracteres)', () => {
    const fallbackOf = (filename: string): string =>
      /filename="([^"]*)"/.exec(
        contentDispositionHeader({ disposition: 'attachment', filename }),
      )?.[1] ?? '';
    expect(fallbackOf('ﷺ'.repeat(255))).toHaveLength(255);
    const withExt = fallbackOf(`${'ﷺ'.repeat(251)}.pdf`);
    expect(withExt).toHaveLength(255);
    expect(withExt.endsWith('.pdf')).toBe(true);
  });

  it('un surrogate suelto no lanza: pasa a U+FFFD', () => {
    expect(
      contentDispositionHeader({
        disposition: 'inline',
        filename: '\uD800a.pdf',
      }),
    ).toBe(`inline; filename="_a.pdf"; filename*=UTF-8''%EF%BF%BDa.pdf`);
  });

  it('un nombre que queda vacío al sanear no se manda', () => {
    expect(
      contentDispositionHeader({ disposition: 'inline', filename: '"\r\n' }),
    ).toBe('inline');
  });
});

describe('contentTypeOf · tipos de documentos del paciente (DX-151)', () => {
  it.each([
    ['clinical/a.heic', 'image/heic'],
    ['clinical/a.HEIC', 'image/heic'],
    [
      'clinical/a.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    ['clinical/a.dcm', 'application/dicom'],
    ['clinical/a.pdf', 'application/pdf'],
  ])('%s → %s', (key, type) => {
    expect(contentTypeOf(key)).toBe(type);
  });
});

describe('isServableContentType (DX-151)', () => {
  it('solo los tipos de la lista blanca', () => {
    expect(isServableContentType('application/pdf')).toBe(true);
    expect(isServableContentType('application/dicom')).toBe(true);
    expect(isServableContentType('text/html')).toBe(false);
    expect(isServableContentType('image/svg+xml')).toBe(false);
    expect(isServableContentType('application/octet-stream')).toBe(false);
    expect(isServableContentType('application/pdf; charset=utf-8')).toBe(false);
  });
});
