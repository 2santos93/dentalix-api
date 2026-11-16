import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import {
  type PdfFontWeight,
  hasUnicodeGlyph,
  primaryUnicodeFont,
  unicodeRuns,
} from '../../../shared/pdf/unicode-fonts';
import type { ExternalOrderPdfModel } from '../domain/external-order';

export const EXTERNAL_ORDER_PDF_RENDERER = Symbol(
  'EXTERNAL_ORDER_PDF_RENDERER',
);

/** Pinta el modelo ya escrito; no decide nada (textos y fechas vienen hechos). */
export interface ExternalOrderPdfRenderer {
  render(model: ExternalOrderPdfModel): Promise<Buffer>;
}

const MARGIN = 56;
const MUTED = '#555555';
const VOID_RED = '#B42318';
const LOGO_BOX: [number, number] = [120, 48];

type FontSource = PDFKit.Mixins.PDFFontSource;
type TextOptions = PDFKit.Mixins.TextOptions;

/** Un carácter sin glifo en las fuentes embebidas sale como «?». */
function paintable(text: string): string {
  let out = '';
  for (const ch of text) out += ch === '\n' || hasUnicodeGlyph(ch) ? ch : '?';
  return out;
}

/** Texto con las fuentes Noto embebidas (DX-459), en tramos de una fuente. */
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

/** PNG o JPEG por su firma: lo único que pdfkit pinta. */
export function isPaintableLogo(bytes: Buffer | null): bytes is Buffer {
  if (!bytes || bytes.length < 4) return false;
  const png = bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG';
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return png || jpeg;
}

/**
 * DX-572: PDF de la orden de estudios o referencia con pdfkit (como los
 * certificados de DX-306) y SIEMPRE con las fuentes Noto embebidas. A4.
 * Cabecera con el logo congelado (si se puede pintar), título por tipo,
 * número y fecha de la sede, datos del paciente, destinatario, estudios,
 * dientes, la nota si corresponde, el profesional con su registro y la línea
 * de firma. Anulada: sello «ANULADA» y la línea con fecha y motivo.
 * Determinista: las fechas de los metadatos son las de la emisión.
 */
@Injectable()
export class PdfkitExternalOrderPdfRenderer implements ExternalOrderPdfRenderer {
  constructor(private readonly options: { compress?: boolean } = {}) {}

  render(model: ExternalOrderPdfModel): Promise<Buffer> {
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
    this.header(doc, model, width);

    paint(doc, model.title.toUpperCase(), 'bold', 15, {
      width,
      align: 'center',
    });
    paint(doc, `${model.numberLabel} · ${model.dateLine}`, 'regular', 10, {
      width,
      align: 'center',
    });
    doc.moveDown(1.5);

    for (const field of model.fields) {
      paint(doc, `${field.label}: ${field.value}`, 'regular', 11, { width });
    }
    doc.moveDown();
    paint(doc, model.itemsLabel, 'bold', 11, { width });
    for (const item of model.items) {
      paint(doc, `•  ${item}`, 'regular', 11, { width, lineGap: 2 });
    }
    if (model.teeth) {
      doc.moveDown(0.5);
      paint(doc, model.teeth, 'regular', 11, { width });
    }
    if (model.note) {
      doc.moveDown();
      paint(doc, 'Nota clínica', 'bold', 11, { width });
      paint(doc, model.note, 'regular', 11, { width, lineGap: 2 });
    }
    if (model.noteOmitted) {
      doc.moveDown(0.5);
      doc.fillColor(MUTED);
      paint(doc, model.noteOmitted, 'regular', 9, { width });
      doc.fillColor('black');
    }
    doc.moveDown(4);

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

  private header(
    doc: PDFKit.PDFDocument,
    model: ExternalOrderPdfModel,
    width: number,
  ): void {
    const top = doc.y;
    let textX = MARGIN;
    if (isPaintableLogo(model.logo)) {
      try {
        doc.image(model.logo, MARGIN, top, { fit: LOGO_BOX });
        textX = MARGIN + LOGO_BOX[0] + 12;
      } catch {
        // Un logo que pdfkit no sabe leer no impide imprimir la orden.
        textX = MARGIN;
      }
    }
    const textWidth = width - (textX - MARGIN);
    doc.x = textX;
    doc.y = top;
    doc.fillColor('black');
    paint(doc, model.header.clinic, 'bold', 13, { width: textWidth });
    doc.fillColor(MUTED);
    for (const line of model.header.lines) {
      paint(doc, line, 'regular', 9, { width: textWidth });
    }
    doc.fillColor('black');
    doc.x = MARGIN;
    doc.y = Math.max(doc.y, top + (textX === MARGIN ? 0 : LOGO_BOX[1]));
    doc.moveDown(2);
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
