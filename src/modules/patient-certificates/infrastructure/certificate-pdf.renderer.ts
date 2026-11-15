import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import {
  type PdfFontWeight,
  hasUnicodeGlyph,
  primaryUnicodeFont,
  unicodeRuns,
} from '../../../shared/pdf/unicode-fonts';
import type { CertificatePdfModel } from '../domain/patient-certificate';

export const CERTIFICATE_PDF_RENDERER = Symbol('CERTIFICATE_PDF_RENDERER');

/** Pinta el modelo ya escrito; no decide nada (textos y horas vienen hechos). */
export interface CertificatePdfRenderer {
  render(model: CertificatePdfModel): Promise<Buffer>;
}

const MARGIN = 64;
const MUTED = '#555555';
const VOID_RED = '#B42318';

type FontSource = PDFKit.Mixins.PDFFontSource;
type TextOptions = PDFKit.Mixins.TextOptions;

/**
 * Un carácter que ninguna fuente embebida tiene (p. ej. una escritura de
 * derecha a izquierda, sin maquetación bidi) sale como «?»: un certificado no
 * deja de emitirse por un glifo.
 */
function paintable(text: string): string {
  let out = '';
  for (const ch of text) out += ch === '\n' || hasUnicodeGlyph(ch) ? ch : '?';
  return out;
}

/**
 * Texto con las fuentes Noto embebidas (DX-459): cada línea en tramos de una
 * sola fuente pintados seguidos con el mismo ajuste de línea.
 */
function paint(
  doc: PDFKit.PDFDocument,
  text: string,
  weight: PdfFontWeight,
  size: number,
  options?: TextOptions,
): void {
  for (const line of paintable(text).split('\n')) {
    const runs = unicodeRuns(line, weight) ?? [];
    if (runs.length === 0) {
      doc
        .font(primaryUnicodeFont(weight) as unknown as FontSource)
        .fontSize(size)
        .moveDown();
      continue;
    }
    runs.forEach((run, i) => {
      doc
        .font(run.font as unknown as FontSource)
        .fontSize(size)
        .text(run.text, { ...options, continued: i < runs.length - 1 });
    });
  }
}

/**
 * DX-306: PDF del justificante o del certificado de reposo con pdfkit (JS
 * puro, como el PDF firmado de DX-422) y SIEMPRE con las fuentes Noto
 * embebidas (DX-459): nombres en cualquier alfabeto latino, griego, cirílico
 * o CJK. A4, una página. Anulado: sello «ANULADO» en diagonal y la línea con
 * fecha y motivo. Determinista: las fechas de los metadatos son las de la
 * emisión, así que reimprimir da el mismo fichero.
 */
@Injectable()
export class PdfkitCertificatePdfRenderer implements CertificatePdfRenderer {
  constructor(private readonly options: { compress?: boolean } = {}) {}

  render(model: CertificatePdfModel): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      compress: this.options.compress ?? true,
      lang: 'es',
      displayTitle: true,
      info: {
        Title: `${model.title} ${model.numberLabel}`,
        Author: model.clinicName,
        Subject: model.title,
        Creator: 'Dentalix',
        Producer: 'Dentalix',
        CreationDate: model.issuedAt,
        ModDate: model.issuedAt,
      },
    });
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const width = doc.page.width - 2 * MARGIN;
    doc.fillColor('black');
    paint(doc, model.header.clinic, 'bold', 13, { width });
    doc.fillColor(MUTED);
    for (const line of model.header.lines)
      paint(doc, line, 'regular', 9, { width });
    doc.fillColor('black').moveDown(2);

    paint(doc, model.title.toUpperCase(), 'bold', 16, {
      width,
      align: 'center',
    });
    paint(doc, model.numberLabel, 'regular', 10, { width, align: 'center' });
    doc.moveDown(2);

    for (const paragraph of model.paragraphs) {
      paint(doc, paragraph, 'regular', 11, {
        width,
        align: 'justify',
        lineGap: 3,
      });
      doc.moveDown();
    }
    if (model.notes.length > 0) {
      doc.fillColor(MUTED);
      for (const note of model.notes) paint(doc, note, 'regular', 9, { width });
      doc.fillColor('black');
    }
    doc.moveDown(5);

    const lineY = doc.y;
    doc
      .moveTo(MARGIN, lineY)
      .lineTo(MARGIN + 220, lineY)
      .strokeColor('#000000')
      .lineWidth(0.6)
      .stroke();
    doc.y = lineY + 6;
    for (const [i, line] of model.signature.entries()) {
      paint(doc, line, i === 0 ? 'bold' : 'regular', 10, { width: 320 });
    }
    doc.moveDown(2);
    doc.fillColor(MUTED);
    paint(doc, model.issuedLine, 'regular', 9, { width });
    doc.fillColor('black');

    if (model.voided) this.stampVoided(doc, model.voided, width);
    doc.end();
    return done;
  }

  private stampVoided(
    doc: PDFKit.PDFDocument,
    voided: { stamp: string; line: string },
    width: number,
  ): void {
    doc.moveDown(2);
    doc.fillColor(VOID_RED);
    paint(doc, voided.line, 'bold', 10, { width });
    const { width: pageWidth, height: pageHeight } = doc.page;
    doc.save();
    doc.rotate(-35, { origin: [pageWidth / 2, pageHeight / 2] });
    doc.fillOpacity(0.18);
    doc
      .font(primaryUnicodeFont('bold') as unknown as FontSource)
      .fontSize(96)
      .text(voided.stamp, 0, pageHeight / 2 - 60, {
        width: pageWidth,
        align: 'center',
        lineBreak: false,
      });
    doc.restore();
    doc.fillColor('black');
  }
}
