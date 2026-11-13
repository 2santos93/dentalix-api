import { createHash } from 'node:crypto';
import { LATIN_PIN_MODEL } from './__fixtures__/latin-pin-model';
import { pdfContentSha256 } from './__fixtures__/pdf-normalize';
import { PdfkitSignedConsentPdfRenderer } from './signed-consent-pdf.renderer';

const sha256 = (pdf: Buffer) => createHash('sha256').update(pdf).digest('hex');

/**
 * Bytes del PDF de PRODUCCIÓN (comprimido) por plataforma: el `deflate` de
 * Node (zlib con optimizaciones por CPU) da otros bytes con los mismos datos
 * en otra arquitectura. darwin-arm64 se tomó con el renderer de DX-422 sin
 * cambios (origin/main 6371c3a7). En otra plataforma el caso de contenido
 * (igual en todas) ya lo cubre, y zlib es determinista en una misma
 * plataforma: mismo contenido, mismos bytes que antes de DX-459.
 */
const PRODUCTION_BYTES: Record<string, { length: number; sha256: string }> = {
  'darwin-arm64': {
    length: 5408,
    sha256: '236d32b6614f5b7e83c769fa2556e9b3a10f211abfc67357720081e992697c98',
  },
};

/**
 * DX-459 (criterio 2): un PDF firmado SOLO latino sale byte a byte como
 * antes de las fuentes Unicode. Las huellas se tomaron con el renderer de
 * DX-422 sin cambios (pdfkit 0.20.2, fijado en package.json): si cambian, la
 * huella guardada (`patient_documents.sha256`) de un PDF regenerado ya no
 * coincidiría con la de uno archivado. Que NO se actualicen sin entender por
 * qué cambian.
 */
describe('PDF firmado latino: bytes fijados (DX-459)', () => {
  it('sin comprimir: misma huella SHA-256 en cualquier plataforma (fuentes estándar, sin fuente embebida)', async () => {
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

  it('producción (comprimido): el mismo contenido (flujos descomprimidos) en cualquier plataforma', async () => {
    const pdf = await new PdfkitSignedConsentPdfRenderer().render(
      LATIN_PIN_MODEL,
    );
    expect(pdfContentSha256(pdf)).toBe(
      '91ccf07f8c32ce750232396febfd6f4517a8a45eb76ff9c08e2c6232b353ba7f',
    );
  });

  it('producción (comprimido): los mismos bytes en las plataformas fijadas', async () => {
    const pdf = await new PdfkitSignedConsentPdfRenderer().render(
      LATIN_PIN_MODEL,
    );
    const platform = `${process.platform}-${process.arch}`;
    const pinned = PRODUCTION_BYTES[platform];
    if (!pinned) {
      // Plataforma sin bytes fijados: el contenido ya lo fija el caso anterior.
      console.info(
        `latin-pin ${platform}: ${pdf.length} bytes, sha256 ${sha256(pdf)}`,
      );
      return;
    }
    expect({ length: pdf.length, sha256: sha256(pdf) }).toEqual(pinned);
  });
});
