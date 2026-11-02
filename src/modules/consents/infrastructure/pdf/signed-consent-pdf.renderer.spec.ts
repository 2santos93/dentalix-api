import type { SignedConsentPdfModel } from '../../domain/signed-consent-pdf';
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
