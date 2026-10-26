import {
  dicomFixture,
  docxFixture,
  emlFake,
  heicFixture,
  htmlFake,
  jpegFixture,
  pdfFixture,
  pngFixture,
  svgFake,
  textFake,
} from '../../../../test/support/document-fixtures';
import {
  MAX_RECEIPT_BYTES,
  declaredLooksLikeReceipt,
  declaredMatchesDetected,
  pendingReceiptKey,
  receiptStorageKey,
  sniffReceiptFrom,
} from './expense-receipt';
import { isFileKey } from '../../../shared/storage/file-key';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UPLOAD = '22222222-2222-4222-8222-222222222222';
const SHA = 'ab'.repeat(32);

const sniff = (bytes: Buffer) =>
  sniffReceiptFrom({
    size: bytes.length,
    read: (start, end) => Promise.resolve(bytes.subarray(start, end)),
  });

describe('soporte del gasto (DX-274, R7)', () => {
  it('el tope es de 20 MB', () => {
    expect(MAX_RECEIPT_BYTES).toBe(20 * 1024 * 1024);
  });

  describe('tipo por contenido, restringido a PDF/JPG/PNG', () => {
    it.each([
      ['PDF', pdfFixture(), 'application/pdf'],
      ['JPEG', jpegFixture(), 'image/jpeg'],
      ['PNG', pngFixture(), 'image/png'],
    ])('reconoce %s', async (_name, bytes, type) => {
      expect(await sniff(bytes)).toBe(type);
    });

    it.each([
      ['HEIC (se convierte a JPG en el navegador)', heicFixture()],
      ['DOCX', docxFixture()],
      ['DICOM', dicomFixture()],
      ['HTML', htmlFake()],
      ['SVG', svgFake()],
      ['EML', emlFake()],
      ['texto', textFake()],
      ['vacío', Buffer.alloc(0)],
    ])('rechaza %s aunque otro detector lo reconozca', async (_name, bytes) => {
      expect(await sniff(bytes)).toBeNull();
    });
  });

  describe('claves del almacén', () => {
    it('definitiva: expense-receipts/<tenant>/<attempt>-<sha16>.<ext>', () => {
      expect(receiptStorageKey(TENANT, UPLOAD, 'application/pdf', SHA)).toBe(
        `expense-receipts/${TENANT}/${UPLOAD}-${SHA.slice(0, 16)}.pdf`,
      );
      expect(receiptStorageKey(TENANT, UPLOAD, 'image/jpeg', SHA)).toMatch(
        /\.jpg$/,
      );
      expect(receiptStorageKey(TENANT, UPLOAD, 'image/png', SHA)).toMatch(
        /\.png$/,
      );
    });

    it('pendiente: expense-receipts/pending/<tenant>/<upload>', () => {
      expect(pendingReceiptKey(TENANT, UPLOAD)).toBe(
        `expense-receipts/pending/${TENANT}/${UPLOAD}`,
      );
    });

    it('las dos son claves válidas del almacén y la pendiente no cuelga de la definitiva', () => {
      expect(isFileKey(pendingReceiptKey(TENANT, UPLOAD))).toBe(true);
      expect(
        isFileKey(receiptStorageKey(TENANT, UPLOAD, 'application/pdf', SHA)),
      ).toBe(true);
      expect(pendingReceiptKey(TENANT, UPLOAD)).not.toMatch(
        new RegExp(`^expense-receipts/${TENANT}/`),
      );
    });

    it('ids que no son uuid o huella que no es hex son errores de programación', () => {
      expect(() => pendingReceiptKey('../x', UPLOAD)).toThrow();
      expect(() => pendingReceiptKey(TENANT, 'no')).toThrow();
      expect(() =>
        receiptStorageKey(TENANT, UPLOAD, 'image/png', 'xyz'),
      ).toThrow();
    });
  });

  describe('lo declarado al pedir la subida', () => {
    it.each([
      [{ mimeType: 'application/pdf', name: 'f.pdf' }, true],
      [{ mimeType: 'image/jpg', name: 'f.JPEG' }, true],
      [{ mimeType: 'image/png', name: 'scan' }, true],
      [{ mimeType: 'application/octet-stream', name: 'f.pdf' }, true],
      [{ mimeType: '', name: '' }, true],
      [{ mimeType: 'image/heic', name: 'f.heic' }, false],
      [{ mimeType: 'image/svg+xml', name: 'f.svg' }, false],
      [{ mimeType: 'text/html', name: 'f.pdf' }, false],
      [{ mimeType: 'application/pdf', name: 'f.docx' }, false],
      [{ mimeType: 'application/pdf', name: 'f.heic' }, false],
    ])('%j → %s', (declared, ok) => {
      expect(declaredLooksLikeReceipt(declared)).toBe(ok);
    });
  });

  describe('lo declarado frente a lo detectado', () => {
    it('cuadra con alias de MIME y extensiones del mismo tipo', () => {
      expect(
        declaredMatchesDetected(
          { mimeType: 'image/pjpeg', name: 'foto.jfif' },
          'image/jpeg',
        ),
      ).toBe(true);
      expect(
        declaredMatchesDetected(
          { mimeType: 'application/octet-stream', name: 'IM0001' },
          'application/pdf',
        ),
      ).toBe(true);
    });

    it('no cuadra si la etiqueta o la extensión son de otro tipo (un PNG llamado .pdf)', () => {
      expect(
        declaredMatchesDetected(
          { mimeType: 'application/pdf', name: 'a.pdf' },
          'image/png',
        ),
      ).toBe(false);
      expect(
        declaredMatchesDetected(
          { mimeType: 'image/png', name: 'factura.pdf' },
          'image/png',
        ),
      ).toBe(false);
    });
  });
});
