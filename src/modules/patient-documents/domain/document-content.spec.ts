import {
  declaredTypeMatches,
  DetectedType,
  extensionOf,
  FILE_TOO_LARGE_MESSAGE,
  isInlineViewable,
  MAX_PATIENT_DOCUMENT_BYTES,
  sniffDocument,
  TYPE_MISMATCH_MESSAGE,
  UNSUPPORTED_TYPE_MESSAGE,
} from './document-content';
import {
  dicomFixture,
  docxFixture,
  emlFake,
  heicFixture,
  htmlFake,
  jpegFixture,
  pdfFixture,
  pngFixture,
  pngRenamedAsPdf,
  svgFake,
  textFake,
  xlsxLikeZipFake,
  zipFixture,
  zipMentioningDocxFake,
} from '../../../../test/support/document-fixtures';

const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('sniffDocument (DX-151)', () => {
  it.each<[string, () => Buffer, DetectedType]>([
    ['PDF', pdfFixture, 'application/pdf'],
    ['JPEG', jpegFixture, 'image/jpeg'],
    ['PNG', pngFixture, 'image/png'],
    ['HEIC', () => heicFixture(), 'image/heic'],
    ['DOCX', docxFixture, DOCX],
    ['DICOM', dicomFixture, 'application/dicom'],
  ])('%s válido se detecta por su contenido', (_label, make, expected) => {
    expect(sniffDocument(make())).toBe(expected);
  });

  it.each(['heic', 'heix', 'mif1', 'msf1', 'hevc'])(
    'HEIC con marca %s',
    (brand) => {
      expect(sniffDocument(heicFixture(brand))).toBe('image/heic');
    },
  );

  it.each<[string, () => Buffer]>([
    ['SVG', svgFake],
    ['HTML', htmlFake],
    ['EML', emlFake],
    ['texto', textFake],
    ['ZIP de Excel (xl/workbook.xml)', xlsxLikeZipFake],
    ['ZIP que solo MENCIONA word/document.xml', zipMentioningDocxFake],
    ['ZIP vacío', () => zipFixture([])],
    ['ftyp con marca que no es HEIC (mp4)', () => heicFixture('isom')],
    ['vacío', () => Buffer.alloc(0)],
    ['preámbulo DICOM sin DICM', () => Buffer.alloc(200)],
  ])('%s → null', (_label, make) => {
    expect(sniffDocument(make())).toBeNull();
  });

  it('DOCX truncado (sin directorio central) → null', () => {
    const docx = docxFixture();
    expect(sniffDocument(docx.subarray(0, docx.length - 30))).toBeNull();
  });

  it('un ZIP con el directorio central fuera de rango → null (no revienta)', () => {
    const docx = Buffer.from(docxFixture());
    // Offset del directorio central apuntando más allá del fichero.
    docx.writeUInt32LE(0xfffffff0, docx.length - 6);
    expect(sniffDocument(docx)).toBeNull();
  });

  it('un DICOM cuyo preámbulo empieza por PK\\x03\\x04 sigue siendo DICOM', () => {
    const zipLike = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(sniffDocument(dicomFixture(zipLike))).toBe('application/dicom');
  });

  it('un PNG renombrado a .pdf se detecta como PNG: manda el contenido', () => {
    expect(sniffDocument(pngRenamedAsPdf().bytes)).toBe('image/png');
  });

  it('una cabecera PNG sin IHDR no es PNG', () => {
    expect(sniffDocument(pngFixture().subarray(0, 8))).toBeNull();
  });
});

describe('declaredTypeMatches', () => {
  it('PNG renombrado a informe.pdf / application/pdf no coincide', () => {
    const f = pngRenamedAsPdf();
    expect(
      declaredTypeMatches(
        { mimeType: f.mimeType, originalName: f.originalName },
        'image/png',
      ),
    ).toBe(false);
  });

  it('un PNG con extensión .pdf aunque el tipo sea genérico no coincide', () => {
    expect(
      declaredTypeMatches(
        { mimeType: 'application/octet-stream', originalName: 'x.pdf' },
        'image/png',
      ),
    ).toBe(false);
  });

  it('un PDF etiquetado como ZIP no coincide (el alias es solo de DOCX)', () => {
    expect(
      declaredTypeMatches(
        { mimeType: 'application/zip', originalName: 'x.zip' },
        'application/pdf',
      ),
    ).toBe(false);
  });

  it('un PNG etiquetado como SVG no coincide', () => {
    expect(
      declaredTypeMatches(
        { mimeType: 'image/svg+xml', originalName: 'x.svg' },
        'image/png',
      ),
    ).toBe(false);
  });

  it.each<[string, string, DetectedType]>([
    ['application/pdf', 'informe.PDF', 'application/pdf'],
    ['image/jpeg', 'foto.jpeg', 'image/jpeg'],
    ['image/jpg', 'foto.JPG', 'image/jpeg'],
    ['image/png', 'rx.png', 'image/png'],
    ['image/heif', 'IMG_0001.HEIC', 'image/heic'],
    ['', 'IMG_0001.heif', 'image/heic'],
    [DOCX, 'informe.docx', DOCX],
    ['application/octet-stream', 'CT.dcm', 'application/dicom'],
    ['application/octet-stream', 'IM000001', 'application/dicom'],
    ['application/dicom', 'serie.dicom', 'application/dicom'],
    ['application/x-dicom', 'CT.dcm', 'application/dicom'],
    ['image/dicom', 'CT.dcm', 'application/dicom'],
    ['application/zip', 'informe.docx', DOCX],
    ['application/x-zip-compressed', 'informe.docx', DOCX],
  ])('%s / %s coincide con %s', (mimeType, originalName, detected) => {
    expect(declaredTypeMatches({ mimeType, originalName }, detected)).toBe(
      true,
    );
  });
});

describe('extensionOf / isInlineViewable / mensajes', () => {
  it.each<[DetectedType, string, boolean]>([
    ['application/pdf', 'pdf', true],
    ['image/jpeg', 'jpg', true],
    ['image/png', 'png', true],
    ['image/heic', 'heic', false],
    [DOCX, 'docx', false],
    ['application/dicom', 'dcm', false],
  ])('%s → .%s, en línea: %s', (type, ext, inline) => {
    expect(extensionOf(type)).toBe(ext);
    expect(isInlineViewable(type)).toBe(inline);
  });

  it('límite y mensajes exactos', () => {
    expect(MAX_PATIENT_DOCUMENT_BYTES).toBe(20 * 1024 * 1024);
    expect(UNSUPPORTED_TYPE_MESSAGE).toBe(
      'Tipo de archivo no admitido. Se aceptan PDF, JPG, PNG, HEIC, DOCX y DICOM.',
    );
    expect(TYPE_MISMATCH_MESSAGE).toBe(
      'El contenido del archivo no coincide con su tipo.',
    );
    expect(FILE_TOO_LARGE_MESSAGE).toBe(
      'El archivo supera el máximo de 20 MB.',
    );
  });
});
