import type { SignedConsentPdfModel } from '../../domain/signed-consent-pdf';
import { pdfFonts, pdfTextLines } from './__fixtures__/pdf-text';
import { PdfkitSignedConsentPdfRenderer } from './signed-consent-pdf.renderer';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const HASH = 'ab'.repeat(32);

function model(body: string): SignedConsentPdfModel {
  return {
    clinicName: 'Clínica Demo',
    title: 'Consentimiento — Exodoncia',
    body,
    signerLabel: 'Laura Castro (paciente)',
    professionalLabel: 'Andrés Gómez Pérez',
    patientSignature: PNG,
    professionalSignature: PNG,
    completedAt: new Date('2026-11-01T02:30:00.000Z'),
    evidence: [
      { label: 'Huella SHA-256 de la firma del paciente', value: HASH },
      { label: 'Zona horaria', value: 'America/Caracas (Sede Centro)' },
    ],
  };
}

/** 0x80–0x9F de WinAnsi que se usan en las pruebas. */
const WIN_ANSI_HIGH: Record<number, string> = { 0x80: '€', 0x97: '—' };

/**
 * Lo que pinta cada operador `TJ` (una línea), decodificado: pdfkit escribe
 * el texto de las fuentes estándar en hex de WinAnsi, partido por el kerning.
 */
function paintedLines(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  return [...raw.matchAll(/\[([^\]]*)\] TJ/g)].map((op) =>
    [...op[1].matchAll(/<([0-9a-f]*)>/g)]
      .map((hex) =>
        [...Buffer.from(hex[1], 'hex')]
          .map((b) => WIN_ANSI_HIGH[b] ?? String.fromCharCode(b))
          .join(''),
      )
      .join(''),
  );
}

describe('PdfkitSignedConsentPdfRenderer (DX-422)', () => {
  const renderer = new PdfkitSignedConsentPdfRenderer({ compress: false });

  it('genera un PDF con el documento y una página final de evidencias', async () => {
    const pdf = await renderer.render(model('Autorizo la exodoncia.'));
    const raw = pdf.toString('latin1');
    expect(raw.startsWith('%PDF-')).toBe(true);
    expect((raw.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(
      2,
    );
    const lines = paintedLines(pdf);
    expect(lines).toContain('Página de evidencias');
    expect(lines).toContain(HASH);
  });

  it('pinta el texto firmado tal cual, línea a línea (acentos, ñ, €, —)', async () => {
    const body = 'Primera línea: ñandú, ¿sí? 1,5 €\n\nSegunda — «fin».';
    const lines = paintedLines(await renderer.render(model(body)));
    const start = lines.indexOf('Primera línea: ñandú, ¿sí? 1,5 €');
    expect(start).toBeGreaterThan(-1);
    // La línea en blanco del texto también se respeta (avanza sin pintar).
    expect(lines[start + 1]).toBe('Segunda — «fin».');
  });

  it('adjunta el texto exacto en UTF-8 (verificable byte a byte)', async () => {
    const body = 'Texto firmado: ñ y €.';
    const raw = (await renderer.render(model(body))).toString('latin1');
    expect(raw).toContain('/EmbeddedFile');
    expect(raw).toContain(
      Buffer.from(`Consentimiento — Exodoncia\n\n${body}`, 'utf8').toString(
        'latin1',
      ),
    );
  });

  it('es determinista: la misma entrada da los mismos bytes', async () => {
    const a = await renderer.render(model('Igual.'));
    const b = await renderer.render(model('Igual.'));
    expect(a.equals(b)).toBe(true);
  });

  it('es determinista aunque el reloj cruce un segundo entre dos generaciones', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      jest.setSystemTime(new Date('2026-11-02T10:00:00.999Z'));
      const a = await renderer.render(model('Igual.'));
      jest.setSystemTime(new Date('2026-11-02T10:00:01.001Z'));
      const b = await renderer.render(model('Igual.'));
      expect(a.equals(b)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('es determinista también comprimido (el que corre en producción)', async () => {
    const prod = new PdfkitSignedConsentPdfRenderer();
    const a = await prod.render(model('Igual.'));
    const b = await prod.render(model('Igual.'));
    expect(a.equals(b)).toBe(true);
  });

  it('es determinista con generaciones simultáneas (el PNG se decodifica de forma asíncrona)', async () => {
    // pdfkit decodifica cada firma PNG con zlib asíncrono: si dos firmas
    // terminan en distinto orden, los objetos salen en otro orden (y con otros
    // números). Se provoca solapando muchas generaciones.
    const base = await renderer.render(model('Igual.'));
    for (let round = 0; round < 600; round++) {
      const batch = await Promise.all(
        Array.from({ length: 8 }, () => renderer.render(model('Igual.'))),
      );
      for (const pdf of batch) expect(pdf.equals(base)).toBe(true);
    }
  }, 90_000); // CI con carga: las 600 rondas son las que cazan el fallo.
});

describe('PdfkitSignedConsentPdfRenderer: fuentes Unicode embebidas (DX-459)', () => {
  const renderer = new PdfkitSignedConsentPdfRenderer({ compress: false });

  const GREEK_TITLE = 'Συγκατάθεση — Согласие — 同意书';
  const BODY_LINES = [
    'Η Ζωή Παπαδοπούλου συναινεί στην εξαγωγή του 38.',
    'Мария Иванова согласна на удаление зуба 38.',
    '患者：山田花子は同意します。',
    '환자 김민준은 동의합니다.',
    'Mixto: Laura 名前 Ζωή Жанна, 1,5 €.',
  ];

  function unicodeModel(): SignedConsentPdfModel {
    return {
      ...model(BODY_LINES.join('\n')),
      title: GREEK_TITLE,
      signerLabel: 'Ζωή Παπαδοπούλου (paciente)',
      evidence: [
        { label: 'Documento', value: GREEK_TITLE },
        { label: 'Zona horaria', value: 'Asia/Tokyo (渋谷院)' },
      ],
    };
  }

  it('griego, cirílico y CJK (chino, japonés, coreano) se pintan tal cual: el texto extraído es el firmado', async () => {
    const pdf = await renderer.render(unicodeModel());
    const lines = pdfTextLines(pdf);
    expect(lines).toContain(GREEK_TITLE);
    const start = lines.indexOf(BODY_LINES[0]);
    expect(start).toBeGreaterThan(-1);
    expect(lines.slice(start, start + BODY_LINES.length)).toEqual(BODY_LINES);
    expect(lines).toContain('Ζωή Παπαδοπούλου (paciente)');
    // La página de evidencias (etiquetas latinas) va con las mismas fuentes.
    expect(lines).toContain('Página de evidencias');
    expect(lines).toContain('Asia/Tokyo (渋谷院)');
  });

  it('también en el PDF comprimido (el de producción) el texto extraído es el firmado', async () => {
    const pdf = await new PdfkitSignedConsentPdfRenderer().render(
      unicodeModel(),
    );
    const lines = pdfTextLines(pdf);
    expect(lines).toContain(GREEK_TITLE);
    for (const line of BODY_LINES) expect(lines).toContain(line);
  });

  it('las fuentes van EMBEBIDAS y en subconjunto (solo los glifos usados), sin Helvetica', async () => {
    const pdf = await renderer.render(unicodeModel());
    const raw = pdf.toString('latin1');
    const used = [...pdfFonts(pdf).values()].map((f) => f.baseFont);
    // Prefijo de subconjunto (6 letras + «+»), como manda la norma PDF.
    expect(used).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^[A-Z]{6}\+NotoSans-Regular$/),
        expect.stringMatching(/^[A-Z]{6}\+NotoSans-Bold$/),
        expect.stringMatching(/^[A-Z]{6}\+NotoSansCJKsc-Regular$/),
      ]) as string[],
    );
    expect(used).not.toContain('Helvetica');
    expect(raw).toContain('/FontFile2'); // TrueType (Noto Sans)
    expect(raw).toContain('/FontFile3'); // CFF (Noto Sans CJK)
    // La CJK entera pesa 16 MB: el PDF lleva solo unas decenas de glifos.
    expect(pdf.length).toBeLessThan(400_000);
  });

  it('árabe: con su fuente embebida (formas unidas; sin reordenar bidi, fuera de alcance)', async () => {
    const arabic = 'يوافق المريض على العلاج';
    const pdf = await renderer.render(
      model(`Autorizo el tratamiento.\n${arabic}`),
    );
    const font = [...pdfFonts(pdf).values()].find((f) =>
      /\+NotoSansArabic-Regular$/.test(f.baseFont),
    );
    expect(font).toBeDefined();
    const glyphs = [...font!.toUnicode!.values()].join('');
    for (const ch of arabic.replace(/ /g, '')) expect(glyphs).toContain(ch);
    expect(pdfTextLines(pdf)).toContain('Autorizo el tratamiento.');
  });

  it('respeta las líneas en blanco del texto firmado', async () => {
    const pdf = await renderer.render({
      ...model('Ζωή\n\nМария'),
      title: GREEK_TITLE,
    });
    const lines = pdfTextLines(pdf);
    const start = lines.indexOf('Ζωή');
    expect(lines[start + 1]).toBe('Мария');
  });

  it('canPaint: lo que tienen las fuentes estándar o las embebidas; no lo demás', () => {
    for (const ch of ['a', 'ñ', '€', 'Ζ', 'Ж', '名', 'ひ', 'カ', '한', 'ع']) {
      expect(renderer.canPaint(ch)).toBe(true);
    }
    // Emoji, devanagari, hebreo, tailandés: sin fuente (UNSUPPORTED_GLYPHS).
    for (const ch of ['😀', 'न', 'ש', 'ส']) {
      expect(renderer.canPaint(ch)).toBe(false);
    }
  });

  it('un PDF con un solo nombre fuera de WinAnsi va entero con las fuentes embebidas', async () => {
    const pdf = await renderer.render({
      ...model('Autorizo la exodoncia.'),
      signerLabel: 'Ζωή Παπαδοπούλου (paciente)',
    });
    const lines = pdfTextLines(pdf);
    expect(lines).toContain('Autorizo la exodoncia.');
    expect(lines).toContain('Ζωή Παπαδοπούλου (paciente)');
    expect([...pdfFonts(pdf).values()].map((f) => f.baseFont)).not.toContain(
      'Helvetica',
    );
  });

  it('determinista (comprimido, el de producción) también con fuentes embebidas y generaciones simultáneas', async () => {
    const prod = new PdfkitSignedConsentPdfRenderer();
    const base = await prod.render(unicodeModel());
    for (let round = 0; round < 20; round++) {
      const batch = await Promise.all(
        Array.from({ length: 4 }, () => prod.render(unicodeModel())),
      );
      for (const pdf of batch) expect(pdf.equals(base)).toBe(true);
    }
  }, 60_000);

  it('adjunta el texto exacto en UTF-8 también con otros alfabetos', async () => {
    const raw = (await renderer.render(unicodeModel())).toString('latin1');
    expect(raw).toContain(
      Buffer.from(
        `${GREEK_TITLE}\n\n${BODY_LINES.join('\n')}`,
        'utf8',
      ).toString('latin1'),
    );
  });
});
