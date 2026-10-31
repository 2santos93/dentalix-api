import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import type { SignedConsentPdfModel } from '../../domain/signed-consent-pdf';

export const SIGNED_CONSENT_PDF_RENDERER = Symbol(
  'SIGNED_CONSENT_PDF_RENDERER',
);

/** Pinta el modelo ya validado; no decide nada (texto, horas y hashes vienen hechos). */
export interface SignedConsentPdfRenderer {
  render(model: SignedConsentPdfModel): Promise<Buffer>;
}

/** Nombre del adjunto con el texto exacto (UTF-8). */
export const SIGNED_TEXT_ATTACHMENT = 'texto-firmado.txt';

const MARGIN = 56;
const SIGNATURE_BOX = { width: 200, height: 80 };
const MUTED = '#555555';

/**
 * PDF firmado con pdfkit (DX-422): JS puro, sin binarios nativos ni navegador.
 * Fuentes estándar (Helvetica, WinAnsi): el dominio ya rechazó lo que no
 * cabe en ellas, así que el texto se pinta tal cual, con sus saltos de línea.
 * Además se ADJUNTA el título y el texto exactos en UTF-8 para verificarlos
 * byte a byte. Determinista: las fechas de los metadatos son la de la firma
 * que lo completó, no la de la generación (un reintento da el mismo PDF).
 */
@Injectable()
export class PdfkitSignedConsentPdfRenderer implements SignedConsentPdfRenderer {
  constructor(private readonly options: { compress?: boolean } = {}) {}

  render(model: SignedConsentPdfModel): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      compress: this.options.compress ?? true,
      lang: 'es',
      displayTitle: true,
      info: {
        Title: model.title,
        Author: model.clinicName,
        Subject: 'Consentimiento firmado a distancia',
        Creator: 'Dentalix',
        Producer: 'Dentalix',
        CreationDate: model.completedAt,
        ModDate: model.completedAt,
      },
    });
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    this.document(doc, model);
    this.evidence(doc, model);
    doc.file(Buffer.from(`${model.title}\n\n${model.body}`, 'utf8'), {
      name: SIGNED_TEXT_ATTACHMENT,
      type: 'text/plain; charset=utf-8',
      description: 'Título y texto firmados, exactos (UTF-8)',
      creationDate: model.completedAt,
      modifiedDate: model.completedAt,
    });
    doc.end();
    return done;
  }

  private document(
    doc: PDFKit.PDFDocument,
    model: SignedConsentPdfModel,
  ): void {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(model.clinicName);
    doc.moveDown(0.5);
    doc
      .font('Helvetica-Bold')
      .fontSize(15)
      .fillColor('black')
      .text(model.title);
    doc.moveDown();
    doc
      .font('Helvetica')
      .fontSize(11)
      .text(model.body.replace(/\r\n/g, '\n'), { lineGap: 2 });
    doc.moveDown(2);
    this.signature(
      doc,
      'Firma de quien firma',
      model.signerLabel,
      model.patientSignature,
    );
    this.signature(
      doc,
      'Firma del profesional',
      model.professionalLabel,
      model.professionalSignature,
    );
  }

  private signature(
    doc: PDFKit.PDFDocument,
    heading: string,
    name: string,
    pngBase64: string,
  ): void {
    const needed = SIGNATURE_BOX.height + 50;
    if (doc.y + needed > doc.page.height - MARGIN) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10).text(heading);
    const top = doc.y + 4;
    doc.image(Buffer.from(pngBase64, 'base64'), MARGIN, top, {
      fit: [SIGNATURE_BOX.width, SIGNATURE_BOX.height],
    });
    doc.y = top + SIGNATURE_BOX.height + 4;
    doc.font('Helvetica').fontSize(10).text(name);
    doc.moveDown();
  }

  private evidence(
    doc: PDFKit.PDFDocument,
    model: SignedConsentPdfModel,
  ): void {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(14).text('Página de evidencias');
    doc.moveDown(0.3);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        'Horas en la zona horaria de la sede desde la que se envió, con su zona IANA y el instante UTC exacto. ' +
          'Las huellas SHA-256 son las guardadas al firmar; el texto exacto va adjunto en UTF-8.',
      );
    doc.fillColor('black').moveDown();
    for (const row of model.evidence) {
      doc.font('Helvetica-Bold').fontSize(9).text(row.label);
      doc.font('Helvetica').fontSize(10).text(row.value);
      doc.moveDown(0.4);
    }
  }
}
