import { pdfTextLines } from '../../consents/infrastructure/pdf/__fixtures__/pdf-text';
import {
  PdfkitExternalOrderPdfRenderer,
  isPaintableLogo,
} from '../infrastructure/external-order-pdf.renderer';
import {
  CLINICAL_NOTE_OMITTED_NOTE,
  buildExternalOrderPdfModel,
  externalOrderFileName,
  readExternalOrderSnapshot,
  type ExternalOrder,
  type ExternalOrderSnapshot,
} from './external-order';

const snapshot: ExternalOrderSnapshot = {
  version: 1,
  patient: {
    name: 'Mariela Rondón',
    document: 'Cédula 12345678',
    ageYears: 34,
  },
  professional: {
    name: 'Dra. Ana Pérez',
    license: 'REG-45678',
    specialty: 'Endodoncia',
  },
  location: {
    name: 'Sede Chacao',
    address: 'Av. Principal 10, Caracas',
    healthRegistrationNumber: null,
    timeZone: 'America/Caracas',
    locale: 'es-VE',
    hourCycle: 'h12',
  },
  clinic: {
    name: 'Clínica Dental Ávila',
    legalName: null,
    taxIdLabel: null,
    taxId: null,
  },
};

const base: ExternalOrder = {
  id: 'o1',
  patientId: 'p1',
  locationId: 'l1',
  appointmentId: null,
  professionalMembershipId: 'm1',
  issuedById: 'u1',
  issuedByName: 'Dra. Ana Pérez',
  kind: 'IMAGING',
  number: 7,
  issuedAt: new Date('2026-11-16T15:00:00Z'),
  status: 'ISSUED',
  recipient: 'Centro de Imagen del Este',
  items: ['Radiografía panorámica', 'Periapical del 36'],
  toothNumbers: ['36'],
  clinicalNote: 'Dolor a la percusión en el 36',
  templateId: null,
  snapshot,
  clinicLogoKey: null,
  documentId: null,
  resultDocumentId: null,
  resultLinkedAt: null,
  resultLinkedById: null,
  resultLinkedByName: null,
  voidedAt: null,
  voidedById: null,
  voidedByName: null,
  voidReason: null,
  voidedDocumentId: null,
};

const renderer = new PdfkitExternalOrderPdfRenderer({ compress: false });
const text = async (order: ExternalOrder, withNote: boolean) =>
  pdfTextLines(
    await renderer.render(buildExternalOrderPdfModel(order, { withNote })),
  ).join('\n');

describe('PDF de la orden externa (DX-572)', () => {
  it('título por tipo, número, fecha de la sede, paciente con documento y edad, destinatario, estudios, dientes y firma', async () => {
    const pdf = await text(base, true);
    for (const piece of [
      'Clínica Dental Ávila',
      'ORDEN DE ESTUDIOS DE IMAGEN',
      'Nº 000007',
      '16 de noviembre de 2026',
      'Paciente: Mariela Rondón',
      'Documento: Cédula 12345678',
      'Edad: 34 años',
      'Centro de imagen: Centro de Imagen del Este',
      'Radiografía panorámica',
      'Dientes: 36',
      'Nota clínica',
      'Dolor a la percusión en el 36',
      'Nº de registro profesional: REG-45678',
    ]) {
      expect(pdf).toContain(piece);
    }
  });

  it('sin la nota: la omite con un aviso (la copia archivada que ven los 4 roles)', async () => {
    const pdf = await text(base, false);
    expect(pdf).not.toContain('Dolor a la percusión');
    expect(pdf).toContain(CLINICAL_NOTE_OMITTED_NOTE);
    // Sin nota en la orden: ni nota ni aviso.
    const plain = await text({ ...base, clinicalNote: null }, false);
    expect(plain).not.toContain(CLINICAL_NOTE_OMITTED_NOTE);
  });

  it('la vista de recepción (nota oculta) nunca la pinta, ni con withNote', async () => {
    const pdf = await text(
      { ...base, clinicalNote: null, clinicalNoteHidden: true },
      true,
    );
    expect(pdf).not.toContain('Dolor a la percusión');
    expect(pdf).toContain(CLINICAL_NOTE_OMITTED_NOTE);
  });

  it('anulada: sello «ANULADA» con la fecha y el motivo', async () => {
    const pdf = await text(
      {
        ...base,
        status: 'VOIDED',
        voidedAt: new Date('2026-11-17T14:00:00Z'),
        voidReason: 'Se pidió el estudio equivocado',
      },
      false,
    );
    expect(pdf).toContain('ANULADA');
    expect(pdf).toContain('Motivo: Se pidió el estudio equivocado');
  });

  it('referencia a especialista: su título y su etiqueta', async () => {
    const pdf = await text(
      { ...base, kind: 'SPECIALIST', items: ['Valoración de ATM'] },
      true,
    );
    expect(pdf).toContain('REFERENCIA A ESPECIALISTA');
    expect(pdf).toContain('Motivo de la referencia');
    expect(pdf).toContain('Especialista: Centro de Imagen del Este');
  });

  it('determinista: reimprimir da el mismo fichero', async () => {
    const model = buildExternalOrderPdfModel(base, { withNote: false });
    const [a, b] = await Promise.all([
      renderer.render(model),
      renderer.render(model),
    ]);
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(a.equals(b)).toBe(true);
  });

  it('el logo: solo PNG o JPEG; uno ilegible no impide imprimir', async () => {
    expect(isPaintableLogo(Buffer.from('<svg/>'))).toBe(false);
    expect(isPaintableLogo(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    const broken = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    const pdf = await renderer.render(
      buildExternalOrderPdfModel(base, { withNote: false, logo: broken }),
    );
    expect(pdftextOk(pdf)).toBe(true);
  });

  it('nombre del fichero por tipo y anulada', () => {
    expect(externalOrderFileName('IMAGING', 7, false)).toBe(
      'orden-imagen-000007.pdf',
    );
    expect(externalOrderFileName('SPECIALIST', 12, true)).toBe(
      'referencia-000012-anulada.pdf',
    );
  });

  it('la foto guardada se lee tolerante (un campo raro sale vacío)', () => {
    expect(
      readExternalOrderSnapshot({ patient: { name: 'Ana', ageYears: -1 } }),
    ).toMatchObject({
      patient: { name: 'Ana', document: null, ageYears: null },
      location: { timeZone: 'UTC', hourCycle: 'h23' },
    });
  });
});

function pdftextOk(pdf: Buffer): boolean {
  return pdfTextLines(pdf).join('\n').includes('ORDEN DE ESTUDIOS DE IMAGEN');
}
