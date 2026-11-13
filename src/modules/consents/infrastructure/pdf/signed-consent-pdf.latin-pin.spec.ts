import { createHash } from 'node:crypto';
import { LATIN_PIN_MODEL } from './__fixtures__/latin-pin-model';
import { PdfkitSignedConsentPdfRenderer } from './signed-consent-pdf.renderer';

const sha256 = (pdf: Buffer) => createHash('sha256').update(pdf).digest('hex');

/**
 * DX-459 (criterio 2): un PDF firmado SOLO latino sale byte a byte como
 * antes de las fuentes Unicode. Las huellas se tomaron con el renderer de
 * DX-422 sin cambios (pdfkit 0.20.2, fijado en package.json): si cambian, la
 * huella guardada (`patient_documents.sha256`) de un PDF regenerado ya no
 * coincidiría con la de uno archivado. Que NO se actualicen sin entender por
 * qué cambian.
 */
describe('PDF firmado latino: bytes fijados (DX-459)', () => {
  it('producción (comprimido): misma huella SHA-256 y mismo tamaño', async () => {
    const pdf = await new PdfkitSignedConsentPdfRenderer().render(
      LATIN_PIN_MODEL,
    );
    expect(pdf.length).toBe(5408);
    expect(sha256(pdf)).toBe(
      '236d32b6614f5b7e83c769fa2556e9b3a10f211abfc67357720081e992697c98',
    );
  });

  it('sin comprimir: misma huella SHA-256 (fuentes estándar, sin fuente embebida)', async () => {
    const pdf = await new PdfkitSignedConsentPdfRenderer({
      compress: false,
    }).render(LATIN_PIN_MODEL);
    expect(sha256(pdf)).toBe(
      '1a528fa888e2b456b5e885ca6b252048ea67544fb4d2e438b7d474c8a8ea69a1',
    );
    const raw = pdf.toString('latin1');
    expect(raw).toContain('/BaseFont /Helvetica');
    expect(raw).not.toContain('/FontFile');
  });
});
