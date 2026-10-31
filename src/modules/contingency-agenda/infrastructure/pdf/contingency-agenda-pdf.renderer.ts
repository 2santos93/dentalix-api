import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import type {
  ContingencyAgendaModel,
  ContingencyDay,
  ContingencyRow,
} from '../../domain/contingency-agenda';

export const CONTINGENCY_AGENDA_RENDERER = Symbol(
  'CONTINGENCY_AGENDA_RENDERER',
);

/** Pinta el modelo ya formateado; no decide nada (horas y textos vienen hechos). */
export interface ContingencyAgendaRenderer {
  render(model: ContingencyAgendaModel): Promise<Buffer>;
}

const MARGIN = 36;
const FOOTER_SPACE = 28;
const CELL_PADDING = 4;
const MUTED = '#555555';
const RULE = '#BBBBBB';
const HEADER_FILL = '#EEEEEE';

/** Columnas en A4 apaisado (770 pt útiles con márgenes de 36). */
const COLUMNS: { key: keyof ContingencyRow; label: string; width: number }[] = [
  { key: 'time', label: 'Hora', width: 118 },
  { key: 'patient', label: 'Paciente', width: 160 },
  { key: 'phone', label: 'Teléfono', width: 110 },
  { key: 'professional', label: 'Profesional', width: 130 },
  { key: 'type', label: 'Tipo de cita', width: 96 },
  { key: 'alerts', label: 'Alertas', width: 156 },
];

/**
 * Agenda de contingencia en PDF (DX-339) con pdfkit, como el PDF firmado
 * (DX-422): JS puro, fuentes estándar (Helvetica, WinAnsi; el dominio ya dejó
 * cada texto pintable). A4 apaisado para que la tabla quepa en una línea por
 * cita y se lea impresa. Cabecera de columnas repetida en cada página y pie
 * con «Página X de Y». Determinista: las fechas de los metadatos son las de
 * la generación del modelo.
 */
@Injectable()
export class PdfkitContingencyAgendaRenderer implements ContingencyAgendaRenderer {
  constructor(private readonly options: { compress?: boolean } = {}) {}

  render(model: ContingencyAgendaModel): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: MARGIN,
      bufferPages: true,
      compress: this.options.compress ?? true,
      lang: 'es',
      displayTitle: true,
      info: {
        Title: `${model.title} · ${model.locationName}`,
        Author: model.clinicName,
        Subject: 'Citas de hoy y mañana de la sede',
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
    for (const day of model.days) this.day(doc, day);
    doc.moveDown();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(model.notice, MARGIN, doc.y, { width: this.contentWidth(doc) });
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

  private header(doc: PDFKit.PDFDocument, model: ContingencyAgendaModel): void {
    const place = [model.clinicName, model.locationName];
    if (model.locationPhone) place.push(`Tel. ${model.locationPhone}`);
    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .fillColor('black')
      .text(model.title, MARGIN, MARGIN);
    doc.font('Helvetica-Bold').fontSize(11).text(place.join(' · '));
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(model.generatedLabel);
    doc.fillColor('black').moveDown();
  }

  private day(doc: PDFKit.PDFDocument, day: ContingencyDay): void {
    // Título + cabecera + al menos una fila juntos: nunca un título huérfano.
    if (doc.y + 70 > this.bottom(doc)) doc.addPage();
    this.dayTitle(doc, day.title);
    if (day.rows.length === 0) {
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(MUTED)
        .text('Sin citas.', MARGIN, doc.y);
      doc.fillColor('black').moveDown();
      return;
    }
    this.columnHeader(doc);
    for (const row of day.rows) {
      const height = this.rowHeight(doc, row);
      if (doc.y + height > this.bottom(doc)) {
        doc.addPage();
        this.dayTitle(doc, `${day.title} (continúa)`);
        this.columnHeader(doc);
      }
      this.row(doc, row, height);
    }
    doc.moveDown();
  }

  private dayTitle(doc: PDFKit.PDFDocument, title: string): void {
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor('black')
      .text(title, MARGIN, doc.y);
    doc.moveDown(0.3);
  }

  private columnHeader(doc: PDFKit.PDFDocument): void {
    const top = doc.y;
    const height = 18;
    doc
      .rect(MARGIN, top, this.contentWidth(doc), height)
      .fill(HEADER_FILL)
      .fillColor('black');
    doc.font('Helvetica-Bold').fontSize(9);
    let x = MARGIN;
    for (const col of COLUMNS) {
      doc.text(col.label, x + CELL_PADDING, top + 5, {
        width: col.width - 2 * CELL_PADDING,
        lineBreak: false,
      });
      x += col.width;
    }
    doc.y = top + height;
  }

  private rowHeight(doc: PDFKit.PDFDocument, row: ContingencyRow): number {
    doc.font('Helvetica').fontSize(9);
    const tallest = Math.max(
      ...COLUMNS.map((col) =>
        doc.heightOfString(row[col.key], {
          width: col.width - 2 * CELL_PADDING,
        }),
      ),
    );
    return tallest + 2 * CELL_PADDING + 2;
  }

  private row(
    doc: PDFKit.PDFDocument,
    row: ContingencyRow,
    height: number,
  ): void {
    const top = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor('black');
    let x = MARGIN;
    for (const col of COLUMNS) {
      doc.text(row[col.key], x + CELL_PADDING, top + CELL_PADDING + 1, {
        width: col.width - 2 * CELL_PADDING,
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

  /** Pie de cada página: de qué sede es (una hoja suelta se identifica) y su número. */
  private footers(
    doc: PDFKit.PDFDocument,
    model: ContingencyAgendaModel,
  ): void {
    const { start, count } = doc.bufferedPageRange();
    for (let i = start; i < start + count; i++) {
      doc.switchToPage(i);
      // Sin margen inferior mientras se pinta el pie: si no, pdfkit abriría
      // otra página al escribir por debajo de él.
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - MARGIN - 10;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(MUTED)
        .text(
          `${model.title} · ${model.locationName} · ${model.generatedLabel}`,
          MARGIN,
          y,
          { lineBreak: false },
        )
        .text(`Página ${i - start + 1} de ${count}`, MARGIN, y, {
          width: this.contentWidth(doc),
          align: 'right',
          lineBreak: false,
        });
      doc.page.margins.bottom = margin;
    }
  }
}
