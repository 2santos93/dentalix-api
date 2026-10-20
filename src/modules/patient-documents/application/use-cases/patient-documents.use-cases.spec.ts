import {
  BadRequestException,
  ConflictException,
  Logger,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { InMemoryFileStorage } from '../../../../shared/storage/__fixtures__/in-memory-file-storage';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import {
  dicomFixture,
  docxFixture,
  heicFixture,
  pdfFixture,
  pngFixture,
  pngRenamedAsPdf,
  svgFake,
  xlsxLikeZipFake,
} from '../../../../../test/support/document-fixtures';
import {
  FILE_TOO_LARGE_MESSAGE,
  MAX_PATIENT_DOCUMENT_BYTES,
  TYPE_MISMATCH_MESSAGE,
  UNSUPPORTED_TYPE_MESSAGE,
} from '../../domain/document-content';
import { sha256Hex } from '../../domain/document-rules';
import { DuplicateActivePatientDocumentError } from '../../domain/ports/patient-document-repository.port';
import {
  InMemoryPatientDocumentRepository,
  LOCATION_ID,
  TENANT_ID,
} from '../__fixtures__/in-memory-patient-documents';
import {
  DOCUMENT_ALREADY_VOIDED_MESSAGE,
  DOCUMENT_NOT_FOUND_MESSAGE,
  DOWNLOAD_ONLY_MESSAGE,
  DUPLICATE_DOCUMENT_MESSAGE,
  GetPatientDocumentUrlUseCase,
  GetPatientDocumentUseCase,
  ListPatientDocumentsUseCase,
  MISSING_FILE_MESSAGE,
  UploadPatientDocumentUseCase,
  VOID_FORBIDDEN_MESSAGE,
  VoidPatientDocumentUseCase,
  type UploadedDocumentFile,
} from './patient-documents.use-cases';

const NOW = new Date('2026-10-17T15:00:00.000Z');
const clock = () => NOW;
const PATIENT = 'p1';
const OTHER_PATIENT = 'p2';
const AUTHOR = 'dr-autor';
const OTHER_DENTIST = 'dr-otro';
const ADMIN = 'admin-1';

const file = (
  bytes: Buffer,
  originalname = 'informe.pdf',
  mimetype = 'application/pdf',
): UploadedDocumentFile => ({
  buffer: bytes,
  originalname,
  mimetype,
  size: bytes.length,
});

describe('Documentos del paciente (DX-151, casos de uso)', () => {
  let repo: InMemoryPatientDocumentRepository;
  let storage: InMemoryFileStorage;
  let ctx: TenantContextService;
  let upload: UploadPatientDocumentUseCase;
  let list: ListPatientDocumentsUseCase;
  let get: GetPatientDocumentUseCase;
  let url: GetPatientDocumentUrlUseCase;
  let voidDoc: VoidPatientDocumentUseCase;

  const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    ctx.run(TENANT_ID, fn);

  const uploadPdf = (overrides: Record<string, string | undefined> = {}) =>
    inTenant(() =>
      upload.execute(
        PATIENT,
        { category: 'REPORT', ...overrides },
        file(pdfFixture()),
        AUTHOR,
      ),
    );

  beforeEach(() => {
    repo = new InMemoryPatientDocumentRepository();
    repo.users.set(AUTHOR, 'Dra. Autora');
    repo.users.set(ADMIN, 'Admin Clínica');
    storage = new InMemoryFileStorage();
    ctx = new TenantContextService();
    const patients = {
      findById: (id: string) =>
        Promise.resolve(id === PATIENT || id === OTHER_PATIENT ? { id } : null),
    } as unknown as PatientRepository;
    upload = new UploadPatientDocumentUseCase(
      repo,
      patients,
      storage,
      ctx,
      clock,
    );
    list = new ListPatientDocumentsUseCase(repo, patients);
    get = new GetPatientDocumentUseCase(repo, patients);
    url = new GetPatientDocumentUrlUseCase(repo, patients, storage, clock, 300);
    voidDoc = new VoidPatientDocumentUseCase(repo, patients);
  });

  describe('subir', () => {
    it('guarda el objeto con el tipo detectado y devuelve el DTO con autor y sede', async () => {
      const doc = await uploadPdf({
        clinicalDate: '2026-10-01',
        toothNumbers: '11, 21',
        notes: '  Control  ',
      });
      expect(doc).toMatchObject({
        patientId: PATIENT,
        locationId: LOCATION_ID,
        category: 'REPORT',
        originalName: 'informe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdfFixture().length,
        sha256: sha256Hex(pdfFixture()),
        clinicalDate: '2026-10-01',
        toothNumbers: ['11', '21'],
        notes: 'Control',
        uploadedById: AUTHOR,
        uploadedByName: 'Dra. Autora',
        inlineViewable: true,
        voidedAt: null,
        voidedByName: null,
      });
      expect(doc).not.toHaveProperty('storageKey');
      expect(doc).not.toHaveProperty('tenantId');
      const key = `patient-documents/${TENANT_ID}/${doc.id}.pdf`;
      expect(storage.saved).toEqual([key]);
      expect(storage.files.get(key)?.contentType).toBe('application/pdf');
    });

    it('la clave del almacén no contiene el nombre original', async () => {
      await inTenant(() =>
        upload.execute(
          PATIENT,
          { category: 'XRAY' },
          file(pngFixture(), 'radiografía-juan-pérez.png', 'image/png'),
          AUTHOR,
        ),
      );
      expect(storage.saved).toHaveLength(1);
      expect(storage.saved[0]).not.toMatch(/radiograf|juan|p.rez/i);
      expect(storage.saved[0]).toMatch(
        new RegExp(`^patient-documents/${TENANT_ID}/[0-9a-f-]{36}\\.png$`),
      );
    });

    it('DICOM sin extensión ni tipo se acepta y no es visible en línea', async () => {
      const doc = await inTenant(() =>
        upload.execute(
          PATIENT,
          { category: 'XRAY' },
          file(dicomFixture(), 'IM000001', 'application/octet-stream'),
          AUTHOR,
        ),
      );
      expect(doc).toMatchObject({
        mimeType: 'application/dicom',
        inlineViewable: false,
      });
    });

    it.each([
      ['SVG', svgFake(), 'dibujo.svg', 'image/svg+xml'],
      ['XLSX-like', xlsxLikeZipFake(), 'hoja.xlsx', 'application/zip'],
    ])(
      'tipo falso (%s) → 400 y no se guarda nada',
      async (_label, bytes, name, mime) => {
        await expect(
          inTenant(() =>
            upload.execute(
              PATIENT,
              { category: 'OTHER' },
              file(bytes, name, mime),
              AUTHOR,
            ),
          ),
        ).rejects.toThrow(new BadRequestException(UNSUPPORTED_TYPE_MESSAGE));
        expect(storage.saved).toEqual([]);
        expect(repo.rows.size).toBe(0);
      },
    );

    it('PNG renombrado .pdf → 400 por tipo que no cuadra, sin guardar', async () => {
      const fake = pngRenamedAsPdf();
      await expect(
        inTenant(() =>
          upload.execute(
            PATIENT,
            { category: 'REPORT' },
            file(fake.bytes, fake.originalName, fake.mimeType),
            AUTHOR,
          ),
        ),
      ).rejects.toThrow(new BadRequestException(TYPE_MISMATCH_MESSAGE));
      expect(storage.saved).toEqual([]);
    });

    it('20 MB + 1 → 413 (la guarda del use-case además del límite de multer)', async () => {
      const big = Buffer.concat([
        pdfFixture(),
        Buffer.alloc(MAX_PATIENT_DOCUMENT_BYTES + 1 - pdfFixture().length),
      ]);
      await expect(
        inTenant(() =>
          upload.execute(PATIENT, { category: 'REPORT' }, file(big), AUTHOR),
        ),
      ).rejects.toThrow(new PayloadTooLargeException(FILE_TOO_LARGE_MESSAGE));
      expect(storage.saved).toEqual([]);
    });

    it('sin archivo o vacío → 400', async () => {
      await expect(
        inTenant(() =>
          upload.execute(PATIENT, { category: 'REPORT' }, undefined, AUTHOR),
        ),
      ).rejects.toThrow(new BadRequestException(MISSING_FILE_MESSAGE));
      await expect(
        inTenant(() =>
          upload.execute(
            PATIENT,
            { category: 'REPORT' },
            file(Buffer.alloc(0)),
            AUTHOR,
          ),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it.each([
      [{ category: 'SELFIE' }, 'La categoría no es válida.'],
      [{ category: undefined }, 'La categoría no es válida.'],
      [
        { category: 'XRAY', toothNumbers: '11,99' },
        'El diente «99» no es un número FDI válido.',
      ],
      [
        { category: 'XRAY', clinicalDate: '2026-10-18' },
        'La fecha clínica no puede ser futura.',
      ],
      [
        { category: 'XRAY', notes: 'x'.repeat(501) },
        'Las notas admiten hasta 500 caracteres.',
      ],
    ])('reglas del documento %j → 400 «%s»', async (fields, message) => {
      await expect(
        inTenant(() =>
          upload.execute(PATIENT, fields, file(pdfFixture()), AUTHOR),
        ),
      ).rejects.toThrow(new BadRequestException(message));
      expect(storage.saved).toEqual([]);
    });

    it('paciente de otra clínica → 404 sin guardar', async () => {
      await expect(
        inTenant(() =>
          upload.execute(
            'ajeno',
            { category: 'REPORT' },
            file(pdfFixture()),
            AUTHOR,
          ),
        ),
      ).rejects.toThrow(NotFoundException);
      expect(storage.saved).toEqual([]);
    });

    it('duplicado vigente del mismo paciente → 409; tras anularlo se puede volver a subir', async () => {
      const first = await uploadPdf();
      await expect(uploadPdf()).rejects.toThrow(
        new ConflictException(DUPLICATE_DOCUMENT_MESSAGE),
      );
      expect(storage.saved).toHaveLength(1);
      // Otro paciente sí puede tener el mismo contenido.
      await inTenant(() =>
        upload.execute(
          OTHER_PATIENT,
          { category: 'REPORT' },
          file(pdfFixture()),
          AUTHOR,
        ),
      );
      await voidDoc.execute(PATIENT, first.id, 'Subido por error', {
        userId: AUTHOR,
        role: ClinicRole.DENTIST,
      });
      await expect(uploadPdf()).resolves.toMatchObject({ voidedAt: null });
    });

    it('carrera: el INSERT choca con el único parcial → 409 y se borra el objeto', async () => {
      repo.failNextCreate = new DuplicateActivePatientDocumentError();
      await expect(uploadPdf()).rejects.toThrow(
        new ConflictException(DUPLICATE_DOCUMENT_MESSAGE),
      );
      expect(storage.saved).toHaveLength(1);
      expect(storage.deleted).toEqual(storage.saved);
      expect(storage.files.size).toBe(0);
    });

    it('si el INSERT falla por otra causa, se borra el objeto y el error sube tal cual', async () => {
      const boom = new Error('fallo de BD');
      repo.failNextCreate = boom;
      await expect(uploadPdf()).rejects.toBe(boom);
      expect(storage.deleted).toEqual(storage.saved);
    });

    it('si además falla el borrado del objeto, sigue subiendo el error del INSERT', async () => {
      const boom = new Error('fallo de BD');
      repo.failNextCreate = boom;
      storage.delete = () => Promise.reject(new Error('bucket caído'));
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      await expect(uploadPdf()).rejects.toBe(boom);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toMatch(/requestId=/);
      expect(line).not.toContain('patient-documents/');
      expect(line).not.toContain(TENANT_ID);
      expect(line).not.toContain('bucket caído');
      warn.mockRestore();
    });
  });

  describe('listar y ver', () => {
    it('lista más reciente primero, incluye anulados y filtra por categoría y diente', async () => {
      const report = await uploadPdf({ toothNumbers: '11' });
      const xray = await inTenant(() =>
        upload.execute(
          PATIENT,
          { category: 'XRAY', toothNumbers: '21' },
          file(pngFixture(), 'rx.png', 'image/png'),
          AUTHOR,
        ),
      );
      await voidDoc.execute(PATIENT, report.id, 'Duplicado', {
        userId: AUTHOR,
        role: ClinicRole.DENTIST,
      });
      const all = await list.execute(PATIENT, {});
      expect(all.map((d) => d.id)).toEqual([xray.id, report.id]);
      expect(all[1].voidedByName).toBe('Dra. Autora');
      expect(
        (await list.execute(PATIENT, { category: 'XRAY' })).map((d) => d.id),
      ).toEqual([xray.id]);
      expect(
        (await list.execute(PATIENT, { tooth: '11' })).map((d) => d.id),
      ).toEqual([report.id]);
    });

    it('filtros inválidos → 400; paciente ajeno → 404', async () => {
      await expect(list.execute(PATIENT, { category: 'NOPE' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(list.execute(PATIENT, { tooth: '99' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(list.execute('ajeno', {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('detalle: 404 si es de otro paciente o no existe', async () => {
      const doc = await uploadPdf();
      await expect(get.execute(PATIENT, doc.id)).resolves.toMatchObject({
        id: doc.id,
      });
      await expect(get.execute(OTHER_PATIENT, doc.id)).rejects.toThrow(
        new NotFoundException(DOCUMENT_NOT_FOUND_MESSAGE),
      );
    });
  });

  describe('URL firmadas', () => {
    it('inline de un PDF: disposición, nombre y tipo firmados, TTL y caducidad', async () => {
      const doc = await uploadPdf();
      const res = await url.execute(PATIENT, doc.id, 'inline');
      expect(res.disposition).toBe('inline');
      expect(res.expiresAt).toBe('2026-10-17T15:05:00.000Z');
      const signed = new URL(res.url);
      expect(signed.searchParams.get('ttl')).toBe('300');
      expect(signed.searchParams.get('disposition')).toBe('inline');
      expect(signed.searchParams.get('filename')).toBe('informe.pdf');
      expect(signed.searchParams.get('type')).toBe('application/pdf');
    });

    it('descarga (attachment) de cualquier tipo, también anulado', async () => {
      const doc = await inTenant(() =>
        upload.execute(
          PATIENT,
          { category: 'REPORT' },
          file(
            docxFixture(),
            'informe.docx',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ),
          AUTHOR,
        ),
      );
      await voidDoc.execute(PATIENT, doc.id, 'Versión vieja', {
        userId: AUTHOR,
        role: ClinicRole.DENTIST,
      });
      const res = await url.execute(PATIENT, doc.id, 'attachment');
      expect(res.disposition).toBe('attachment');
      expect(new URL(res.url).searchParams.get('disposition')).toBe(
        'attachment',
      );
    });

    it.each([
      ['DOCX', docxFixture(), 'a.docx'],
      ['DICOM', dicomFixture(), 'IM1'],
      ['HEIC', heicFixture(), 'foto.heic'],
    ])(
      'inline de %s → 400 «solo se puede descargar»',
      async (_l, bytes, name) => {
        const doc = await inTenant(() =>
          upload.execute(
            PATIENT,
            { category: 'OTHER' },
            file(bytes, name, ''),
            AUTHOR,
          ),
        );
        await expect(url.execute(PATIENT, doc.id, 'inline')).rejects.toThrow(
          new BadRequestException(DOWNLOAD_ONLY_MESSAGE),
        );
      },
    );

    it('404 si el documento no es del paciente', async () => {
      const doc = await uploadPdf();
      await expect(
        url.execute(OTHER_PATIENT, doc.id, 'attachment'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('anular', () => {
    it('el autor anula con motivo; devuelve quién y por qué', async () => {
      const doc = await uploadPdf();
      const voided = await voidDoc.execute(
        PATIENT,
        doc.id,
        '  Paciente equivocado ',
        {
          userId: AUTHOR,
          role: ClinicRole.DENTIST,
        },
      );
      expect(voided).toMatchObject({
        voidedById: AUTHOR,
        voidedByName: 'Dra. Autora',
        voidReason: 'Paciente equivocado',
      });
      expect(voided.voidedAt).toBeInstanceOf(Date);
    });

    it('otro odontólogo → 403; un ADMIN sí puede', async () => {
      const doc = await uploadPdf();
      await expect(
        voidDoc.execute(PATIENT, doc.id, 'No es mío', {
          userId: OTHER_DENTIST,
          role: ClinicRole.DENTIST,
        }),
      ).rejects.toThrow(new ForbiddenException(VOID_FORBIDDEN_MESSAGE));
      await expect(
        voidDoc.execute(PATIENT, doc.id, 'Limpieza', {
          userId: ADMIN,
          role: ClinicRole.ADMIN,
        }),
      ).resolves.toMatchObject({ voidedByName: 'Admin Clínica' });
    });

    it('dos veces → 409; sin motivo → 400; ajeno → 404', async () => {
      const doc = await uploadPdf();
      const actor = { userId: AUTHOR, role: ClinicRole.DENTIST };
      await expect(voidDoc.execute(PATIENT, doc.id, '', actor)).rejects.toThrow(
        BadRequestException,
      );
      await voidDoc.execute(PATIENT, doc.id, 'Primera vez', actor);
      await expect(
        voidDoc.execute(PATIENT, doc.id, 'Segunda vez', actor),
      ).rejects.toThrow(new ConflictException(DOCUMENT_ALREADY_VOIDED_MESSAGE));
      await expect(
        voidDoc.execute(OTHER_PATIENT, doc.id, 'Ajeno', actor),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
