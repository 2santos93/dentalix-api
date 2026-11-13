import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import {
  type PdfFontWeight,
  hasUnicodeGlyph,
  primaryUnicodeFont,
  unicodeRuns,
} from '../../../../shared/pdf/unicode-fonts';
import { isWinAnsiChar } from '../../../../shared/pdf/win-ansi';
import {
  SignedConsentPdfSourceError,
  fitsStandardFonts,
  type SignedConsentPdfModel,
} from '../../domain/signed-consent-pdf';

export const SIGNED_CONSENT_PDF_RENDERER = Symbol(
  'SIGNED_CONSENT_PDF_RENDERER',
);

/** Pinta el modelo ya validado; no decide nada (texto, horas y hashes vienen hechos). */
export interface SignedConsentPdfRenderer {
  /** DX-459: ¿tiene con qué pintar este carácter? (el dominio lo exige antes). */
  canPaint(ch: string): boolean;
  render(model: SignedConsentPdfModel): Promise<Buffer>;
}

/** Nombre del adjunto con el texto exacto (UTF-8). */
export const SIGNED_TEXT_ATTACHMENT = 'texto-firmado.txt';

const MARGIN = 56;
const SIGNATURE_BOX = { width: 200, height: 80 };
const MUTED = '#555555';

const EVIDENCE_HEADING = 'Página de evidencias';
const EVIDENCE_NOTE =
  'Horas en la zona horaria de la sede desde la que se envió, con su zona IANA y el instante UTC exacto. ' +
  'Las huellas SHA-256 son las guardadas al firmar; el texto exacto va adjunto en UTF-8.';
const PATIENT_SIGNATURE_HEADING = 'Firma de quien firma';
const PROFESSIONAL_SIGNATURE_HEADING = 'Firma del profesional';

type TextOptions = PDFKit.Mixins.TextOptions;

/** Pinta un texto con la fuente (y el peso) que toque y lo deja escrito. */
type PaintText = (
  doc: PDFKit.PDFDocument,
  text: string,
  weight: PdfFontWeight,
  size: number,
  options?: TextOptions,
) => void;

/**
 * Fuentes estándar (Helvetica, WinAnsi): el camino de SIEMPRE para un texto
 * que cabe en ellas. Las mismas llamadas a pdfkit que antes de DX-459, así
 * que un PDF latino sale byte a byte igual (y con la misma huella).
 */
const paintStandard: PaintText = (doc, text, weight, size, options) => {
  doc
    .font(weight === 'bold' ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(size)
    .text(text, options);
};

/** Una fuente de fontkit ya abierta: pdfkit la acepta tal cual. */
type FontSource = PDFKit.Mixins.PDFFontSource;

/**
 * DX-459: fuentes Noto embebidas (subconjunto), para un documento con algún
 * texto fuera de WinAnsi. Línea a línea: cada una se parte en tramos de una
 * fuente que se pintan seguidos (`continued`) con el mismo ajuste de línea
 * (pdfkit pierde un salto al final de un tramo seguido, así que los saltos
 * no van dentro de los tramos). Una línea en blanco avanza lo que avanzaría
 * pdfkit. Sin bidi: el dominio niega las escrituras de derecha a izquierda
 * (árabe, hebreo…) hasta que haya maquetación bidi.
 */
const paintUnicode: PaintText = (doc, text, weight, size, options) => {
  if (text === '') return; // Como `text('')`: no avanza.
  for (const line of text.split('\n')) {
    const runs = unicodeRuns(line, weight);
    // El dominio ya lo comprobó con `canPaint`; esto es solo la red.
    if (!runs) throw new SignedConsentPdfSourceError('UNSUPPORTED_GLYPHS');
    if (runs.length === 0) {
      doc
        .font(primaryUnicodeFont(weight) as unknown as FontSource)
        .fontSize(size)
        .moveDown();
      doc.y += options?.lineGap ?? 0;
      continue;
    }
    runs.forEach((run, i) => {
      doc
        .font(run.font as unknown as FontSource)
        .fontSize(size)
        .text(run.text, { ...options, continued: i < runs.length - 1 });
    });
  }
};

/**
 * pdfkit decodifica los PNG con zlib asíncrono y escribe el objeto de la imagen
 * (y su máscara de alfa, con los números de objeto que aún quedan) cuando
 * termina. Con dos firmas el orden dependía de cuál acababa antes: mismo
 * contenido, otros bytes (y otra huella). Se espera a cada imagen antes de
 * seguir para que el orden sea siempre el mismo.
 */
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

/** `openImage` existe en pdfkit pero no está en sus tipos. */
interface WithOpenImage {
  openImage: (src: Buffer) => PDFKit.Mixins.ImageSrc;
}

/** Lo mínimo de las referencias internas de pdfkit que usa `imageWritten`. */
interface PdfkitRef {
  offset?: number;
  finalize: () => void;
}

/**
 * PDF firmado con pdfkit (DX-422): JS puro, sin binarios nativos ni navegador.
 * Si todo cabe en las fuentes estándar (Helvetica, WinAnsi), se pinta con
 * ellas, exactamente como antes de DX-459; si no, todo el documento va con
 * las fuentes Noto embebidas (DX-459). El dominio ya rechazó lo que ninguna
 * de las dos pinta, así que el texto sale tal cual, con sus saltos de línea.
 * Además se ADJUNTA el título y el texto exactos en UTF-8 para verificarlos
 * byte a byte. Determinista: las fechas de los metadatos son la de la firma
 * que lo completó, no la de la generación (un reintento da el mismo PDF).
 */
@Injectable()
export class PdfkitSignedConsentPdfRenderer implements SignedConsentPdfRenderer {
  constructor(private readonly options: { compress?: boolean } = {}) {}

  canPaint(ch: string): boolean {
    return isWinAnsiChar(ch) || hasUnicodeGlyph(ch);
  }

  async render(model: SignedConsentPdfModel): Promise<Buffer> {
    const paint = fitsStandardFonts(model) ? paintStandard : paintUnicode;
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

    await this.document(doc, model, paint);
    this.evidence(doc, model, paint);
    doc.file(Buffer.from(`${model.title}\n\n${model.body}`, 'utf8'), {
      name: SIGNED_TEXT_ATTACHMENT,
      type: 'text/plain; charset=utf-8',
      description: 'Título y texto firmados, exactos (UTF-8)',
      creationDate: model.completedAt,
      modifiedDate: model.completedAt,
    });
    doc.end();
    return await done;
  }

  private async document(
    doc: PDFKit.PDFDocument,
    model: SignedConsentPdfModel,
    paint: PaintText,
  ): Promise<void> {
    doc.fillColor(MUTED);
    paint(doc, model.clinicName, 'regular', 9);
    doc.moveDown(0.5);
    doc.fillColor('black');
    paint(doc, model.title, 'bold', 15);
    doc.moveDown();
    paint(doc, model.body.replace(/\r\n/g, '\n'), 'regular', 11, {
      lineGap: 2,
    });
    doc.moveDown(2);
    await this.signature(
      doc,
      paint,
      PATIENT_SIGNATURE_HEADING,
      model.signerLabel,
      model.patientSignature,
    );
    await this.signature(
      doc,
      paint,
      PROFESSIONAL_SIGNATURE_HEADING,
      model.professionalLabel,
      model.professionalSignature,
    );
  }

  private async signature(
    doc: PDFKit.PDFDocument,
    paint: PaintText,
    heading: string,
    name: string,
    pngBase64: string,
  ): Promise<void> {
    const needed = SIGNATURE_BOX.height + 50;
    if (doc.y + needed > doc.page.height - MARGIN) doc.addPage();
    paint(doc, heading, 'bold', 10);
    const top = doc.y + 4;
    const image = (doc as unknown as WithOpenImage).openImage(
      Buffer.from(pngBase64, 'base64'),
    );
    doc.image(image, MARGIN, top, {
      fit: [SIGNATURE_BOX.width, SIGNATURE_BOX.height],
    });
    await imageWritten(image);
    doc.y = top + SIGNATURE_BOX.height + 4;
    paint(doc, name, 'regular', 10);
    doc.moveDown();
  }

  private evidence(
    doc: PDFKit.PDFDocument,
    model: SignedConsentPdfModel,
    paint: PaintText,
  ): void {
    doc.addPage();
    paint(doc, EVIDENCE_HEADING, 'bold', 14);
    doc.moveDown(0.3);
    doc.fillColor(MUTED);
    paint(doc, EVIDENCE_NOTE, 'regular', 9);
    doc.fillColor('black').moveDown();
    for (const row of model.evidence) {
      paint(doc, row.label, 'bold', 9);
      paint(doc, row.value, 'regular', 10);
      doc.moveDown(0.4);
    }
  }
}
