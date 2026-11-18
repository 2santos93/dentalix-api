import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import type {
  CommissionDocumentModel,
  DocumentRow,
  DocumentSection,
} from '../domain/commission-receipt';

export const COMMISSION_PDF_RENDERER = Symbol('COMMISSION_PDF_RENDERER');

/** Pinta el modelo ya formateado; no decide nada (textos e importes vienen hechos). */
export interface CommissionPdfRenderer {
  render(model: CommissionDocumentModel): Promise<Buffer>;
}

const MARGIN = 40;
const FOOTER_SPACE = 24;
const CELL_PADDING = 4;
const MUTED = '#555555';
const RULE = '#BBBBBB';
const HEADER_FILL = '#EEEEEE';
const SIGNATURE_BOX = { width: 220, height: 90 };

/** Columnas en A4 vertical (515 pt útiles con márgenes de 40). */
const COLUMNS: {
  key: keyof DocumentRow;
  label: string;
  width: number;
  align: 'left' | 'right';
}[] = [
  { key: 'patient', label: 'Paciente', width: 62, align: 'left' },
  { key: 'procedure', label: 'Procedimiento', width: 170, align: 'left' },
  { key: 'date', label: 'Fecha', width: 62, align: 'left' },
  { key: 'base', label: 'Base', width: 80, align: 'right' },
  { key: 'percent', label: '%', width: 46, align: 'right' },
  { key: 'amount', label: 'Honorario', width: 95, align: 'right' },
];

/** `openImage` existe en pdfkit pero no está en sus tipos (como DX-422). */
interface WithOpenImage {
  openImage: (src: Buffer) => PDFKit.Mixins.ImageSrc;
}

interface PdfkitRef {
  offset?: number;
  finalize: () => void;
}

/** Espera a que pdfkit termine de escribir la imagen (DX-422). */
function imageWritten(image: unknown): Promise<void> {
  const obj = (image as { obj?: PdfkitRef }).obj;
  if (!obj || obj.offset !== undefined) return Promise.resolve();
  return new Promise((resolve) => {
    const finalize = obj.finalize.bind(obj);
    obj.finalize = () => {
      finalize();
      resolve();
    };
  });
}

/**
 * PDF de la liquidación de honorarios y del recibo del pago (DX-464) con
 * pdfkit, como la agenda de contingencia (DX-339) y el PDF firmado (DX-422):
 * fuentes estándar (Helvetica, WinAnsi; el dominio ya dejó cada texto
 * pintable), tabla por moneda con la cabecera repetida en cada página y pie
 * con «Página X de Y». Determinista: la fecha de los metadatos es la del
 * modelo.
 */
@Injectable()
export class PdfkitCommissionPdfRenderer implements CommissionPdfRenderer {
  constructor(private readonly options: { compress?: boolean } = {}) {}

  async render(model: CommissionDocumentModel): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true,
      compress: this.options.compress ?? true,
      lang: 'es',
      displayTitle: true,
      info: {
        Title: `${model.title} · ${model.clinicName}`,
        Author: model.clinicName,
        Subject: model.title,
        Creator: 'Dentalix',
        Producer: 'Dentalix',
        CreationDate: model.generatedAt,
        ModDate: model.generatedAt,
      },
    });
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    this.header(doc, model);
    for (const section of model.sections) this.section(doc, section);
    this.notes(doc, model.notes);
    if (model.signature) await this.signature(doc, model.signature);
    this.footers(doc, model);
    doc.end();
    return done;
  }

  private contentWidth(doc: PDFKit.PDFDocument): number {
    return doc.page.width - 2 * MARGIN;
  }

  private bottom(doc: PDFKit.PDFDocument): number {
    return doc.page.height - MARGIN - FOOTER_SPACE;
  }

  private ensure(doc: PDFKit.PDFDocument, height: number): void {
    if (doc.y + height > this.bottom(doc)) doc.addPage();
  }

  private header(
    doc: PDFKit.PDFDocument,
    model: CommissionDocumentModel,
  ): void {
    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .fillColor('black')
      .text(model.title, MARGIN, MARGIN);
    doc.font('Helvetica-Bold').fontSize(11).text(model.clinicName);
    doc.moveDown(0.6);
    for (const fact of model.facts) {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(MUTED)
        .text(`${fact.label}: `, MARGIN, doc.y, { continued: true })
        .font('Helvetica')
        .fillColor('black')
        .text(fact.value);
    }
    doc.moveDown();
  }

  private section(doc: PDFKit.PDFDocument, section: DocumentSection): void {
    this.ensure(doc, 70);
    this.sectionTitle(doc, section.title);
    if (section.rows.length === 0) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(MUTED)
        .text('Sin líneas.', MARGIN, doc.y);
      doc.fillColor('black').moveDown();
    } else {
      this.columnHeader(doc);
      for (const row of section.rows) {
        const height = this.rowHeight(doc, row);
        if (doc.y + height > this.bottom(doc)) {
          doc.addPage();
          this.sectionTitle(doc, `${section.title} (continúa)`);
          this.columnHeader(doc);
        }
        this.row(doc, row, height);
      }
    }
    doc.moveDown(0.4);
    this.ensure(doc, section.totals.length * 14 + 6);
    for (const total of section.totals) {
      const y = doc.y;
      const bold = total.label.startsWith('Total');
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(9)
        .fillColor('black')
        .text(total.label, MARGIN + 250, y, { width: 150, lineBreak: false })
        .text(total.value, MARGIN + 400, y, {
          width: this.contentWidth(doc) - 400,
          align: 'right',
          lineBreak: false,
        });
      doc.y = y + 13;
    }
    doc.moveDown();
  }

  private sectionTitle(doc: PDFKit.PDFDocument, title: string): void {
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('black')
      .text(title, MARGIN, doc.y);
    doc.moveDown(0.3);
  }

  private columnHeader(doc: PDFKit.PDFDocument): void {
    const top = doc.y;
    const height = 16;
    doc
      .rect(MARGIN, top, this.contentWidth(doc), height)
      .fill(HEADER_FILL)
      .fillColor('black');
    doc.font('Helvetica-Bold').fontSize(8);
    let x = MARGIN;
    for (const col of COLUMNS) {
      doc.text(col.label, x + CELL_PADDING, top + 4, {
        width: col.width - 2 * CELL_PADDING,
        align: col.align,
        lineBreak: false,
      });
      x += col.width;
    }
    doc.y = top + height;
  }

  private rowHeight(doc: PDFKit.PDFDocument, row: DocumentRow): number {
    doc.font('Helvetica').fontSize(8);
    const tallest = Math.max(
      ...COLUMNS.map((col) =>
        doc.heightOfString(row[col.key], {
          width: col.width - 2 * CELL_PADDING,
        }),
      ),
    );
    return tallest + 2 * CELL_PADDING;
  }

  private row(doc: PDFKit.PDFDocument, row: DocumentRow, height: number): void {
    const top = doc.y;
    doc.font('Helvetica').fontSize(8).fillColor('black');
    let x = MARGIN;
    for (const col of COLUMNS) {
      doc.text(row[col.key], x + CELL_PADDING, top + CELL_PADDING, {
        width: col.width - 2 * CELL_PADDING,
        align: col.align,
      });
      x += col.width;
    }
    doc
      .moveTo(MARGIN, top + height)
      .lineTo(MARGIN + this.contentWidth(doc), top + height)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();
    doc.y = top + height;
  }

  private notes(doc: PDFKit.PDFDocument, notes: readonly string[]): void {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    for (const note of notes) {
      const width = this.contentWidth(doc);
      this.ensure(doc, doc.heightOfString(note, { width }) + 4);
      doc.text(note, MARGIN, doc.y, { width });
      doc.moveDown(0.2);
    }
    doc.fillColor('black').moveDown();
  }

  private async signature(
    doc: PDFKit.PDFDocument,
    signature: NonNullable<CommissionDocumentModel['signature']>,
  ): Promise<void> {
    this.ensure(
      doc,
      SIGNATURE_BOX.height + 40 + signature.evidence.length * 22,
    );
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('black')
      .text('Recibido conforme', MARGIN, doc.y);
    doc.moveDown(0.3);
    const top = doc.y;
    const image = (doc as unknown as WithOpenImage).openImage(
      Buffer.from(signature.image, 'base64'),
    );
    doc.image(image, MARGIN, top, {
      fit: [SIGNATURE_BOX.width, SIGNATURE_BOX.height],
    });
    await imageWritten(image);
    doc.y = top + SIGNATURE_BOX.height + 6;
    for (const row of signature.evidence) {
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor(MUTED)
        .text(`${row.label}: `, MARGIN, doc.y, { continued: true })
        .font('Helvetica')
        .fillColor('black')
        .text(row.value, { width: this.contentWidth(doc) });
    }
  }

  private footers(
    doc: PDFKit.PDFDocument,
    model: CommissionDocumentModel,
  ): void {
    const { start, count } = doc.bufferedPageRange();
    for (let i = start; i < start + count; i++) {
      doc.switchToPage(i);
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - MARGIN - 8;
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor(MUTED)
        .text(`${model.title} · ${model.clinicName}`, MARGIN, y, {
          lineBreak: false,
        })
        .text(`Página ${i - start + 1} de ${count}`, MARGIN, y, {
          width: this.contentWidth(doc),
          align: 'right',
          lineBreak: false,
        });
      doc.page.margins.bottom = margin;
    }
  }
}
