import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Logger,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ClinicRole, Prisma } from '@prisma/client';
import { InMemoryFileStorage } from '../../../../shared/storage/__fixtures__/in-memory-file-storage';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import {
  dicomFixture,
  docxFixture,
  heicFixture,
  largeDocxFixture,
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
  CHECKSUM_MISMATCH_MESSAGE,
  CompletePatientDocumentUploadUseCase,
  CreatePatientDocumentUploadUseCase,
  PatientDocumentWriter,
  SIZE_MISMATCH_MESSAGE,
  UPLOAD_CHANGED_MESSAGE,
  UPLOAD_NOT_FOUND_MESSAGE,
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

let tempDir: string;
let tempSeq = 0;
beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'patient-documents-spec-'));
});
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

/** El temporal en disco que deja multer (DX-259: nada en memoria). */
const file = (
  bytes: Buffer,
  originalname = 'informe.pdf',
  mimetype = 'application/pdf',
): UploadedDocumentFile => {
  tempSeq += 1;
  const filePath = path.join(tempDir, `upload-${tempSeq}`);
  writeFileSync(filePath, bytes);
  return { path: filePath, originalname, mimetype, size: bytes.length };
};

describe('Documentos del paciente (DX-151, casos de uso)', () => {
  let repo: InMemoryPatientDocumentRepository;
  let storage: InMemoryFileStorage;
  let ctx: TenantContextService;
  let writer: PatientDocumentWriter;
  let upload: UploadPatientDocumentUseCase;
  let createUpload: CreatePatientDocumentUploadUseCase;
  let complete: CompletePatientDocumentUploadUseCase;
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
    writer = new PatientDocumentWriter(repo, patients, storage, ctx, clock);
    upload = new UploadPatientDocumentUseCase(writer, storage);
    createUpload = new CreatePatientDocumentUploadUseCase(
      writer,
      patients,
      storage,
      300,
    );
    complete = new CompletePatientDocumentUploadUseCase(writer, storage);
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

    it('si la sede de escritura no se resuelve, no se guarda el objeto ni se crea la fila', async () => {
      const denied = new ForbiddenException('Sede no permitida');
      repo.failResolveLocation = denied;
      const create = jest.spyOn(repo, 'create');
      await expect(uploadPdf()).rejects.toBe(denied);
      expect(storage.saved).toEqual([]);
      expect(create).not.toHaveBeenCalled();
      expect(repo.rows.size).toBe(0);
    });

    it('la fila se crea con la sede resuelta antes de guardar el objeto', async () => {
      const create = jest.spyOn(repo, 'create');
      await uploadPdf();
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ locationId: LOCATION_ID }),
      );
    });

    it.each([
      [
        'P1001',
        () =>
          new Prisma.PrismaClientKnownRequestError('x', {
            code: 'P1001',
            clientVersion: 't',
          }),
      ],
      [
        'P1002',
        () =>
          new Prisma.PrismaClientKnownRequestError('x', {
            code: 'P1002',
            clientVersion: 't',
          }),
      ],
      [
        'P1008',
        () =>
          new Prisma.PrismaClientKnownRequestError('x', {
            code: 'P1008',
            clientVersion: 't',
          }),
      ],
      [
        'P1017',
        () =>
          new Prisma.PrismaClientKnownRequestError('x', {
            code: 'P1017',
            clientVersion: 't',
          }),
      ],
      [
        'inicialización',
        () => new Prisma.PrismaClientInitializationError('x', 't'),
      ],
      [
        'pánico del motor',
        () => new Prisma.PrismaClientRustPanicError('x', 't'),
      ],
    ])(
      'fallo de conexión (%s) tras el INSERT: el objeto se conserva y el error sube',
      async (_label, make) => {
        const lost = make();
        repo.failNextCreate = lost;
        const warn = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
        await expect(uploadPdf()).rejects.toBe(lost);
        expect(storage.saved).toHaveLength(1);
        expect(storage.deleted).toEqual([]);
        expect(storage.files.size).toBe(1);
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0][0]);
        expect(line).toMatch(/requestId=/);
        expect(line).not.toContain('patient-documents/');
        expect(line).not.toContain(TENANT_ID);
        warn.mockRestore();
      },
    );

    it('un P2002 ajeno al sha256 o un error de validación de Prisma sí borran el objeto', async () => {
      const unique = new Prisma.PrismaClientKnownRequestError('x', {
        code: 'P2002',
        clientVersion: 't',
        meta: { target: ['storageKey'] },
      });
      repo.failNextCreate = unique;
      await expect(uploadPdf()).rejects.toBe(unique);
      expect(storage.deleted).toEqual(storage.saved);

      const invalid = new Prisma.PrismaClientValidationError('x', {
        clientVersion: 't',
      });
      repo.failNextCreate = invalid;
      await expect(uploadPdf()).rejects.toBe(invalid);
      expect(storage.deleted).toEqual(storage.saved);
      expect(storage.files.size).toBe(0);
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

  describe('subida directa al almacén (DX-259)', () => {
    const sha = (bytes: Buffer) => sha256Hex(bytes);
    const pendingKey = (id: string) =>
      `patient-documents/pending/${TENANT_ID}/${id}`;

    const ask = (
      bytes: Buffer,
      overrides: Partial<{
        sizeBytes: number;
        sha256: string;
        patientId: string;
      }> = {},
      by = AUTHOR,
    ) =>
      inTenant(() =>
        createUpload.execute(
          overrides.patientId ?? PATIENT,
          {
            fileName: 'informe.pdf',
            mimeType: 'application/pdf',
            sizeBytes: overrides.sizeBytes ?? bytes.length,
            sha256: overrides.sha256 ?? sha(bytes),
          },
          by,
        ),
      );

    const finish = (
      documentId: string,
      fields: Record<string, unknown> = {},
      by = AUTHOR,
      patientId = PATIENT,
    ) =>
      inTenant(() =>
        complete
          .execute(
            patientId,
            documentId,
            {
              category: 'REPORT',
              fileName: 'informe.pdf',
              mimeType: 'application/pdf',
              ...fields,
            },
            by,
          )
          .then((r) => r.view),
      );

    /** upload-url + lo que haría el navegador con el POST prefirmado. */
    const uploaded = async (bytes: Buffer): Promise<string> => {
      const ticket = await ask(bytes);
      storage.simulateDirectUpload(pendingKey(ticket.documentId), bytes);
      return ticket.documentId;
    };

    it('upload-url: clave pending fijada por la API, 1 B–20 MB, SHA-256 y autor/paciente en metadatos; nada en la ficha', async () => {
      const bytes = pdfFixture();
      const ticket = await ask(bytes);
      expect(ticket.documentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ticket).toMatchObject({
        method: 'POST',
        url: 'memory://bucket',
        maxBytes: MAX_PATIENT_DOCUMENT_BYTES,
      });
      const policy = storage.directUploads.get(pendingKey(ticket.documentId));
      expect(policy).toEqual({
        maxBytes: MAX_PATIENT_DOCUMENT_BYTES,
        sha256Base64: Buffer.from(sha(bytes), 'hex').toString('base64'),
        metadata: {
          'uploaded-by': AUTHOR,
          'patient-id': PATIENT,
          'declared-size': String(bytes.length),
          sha256: sha(bytes),
        },
        ttlSeconds: 300,
      });
      expect(repo.rows.size).toBe(0);
      expect(storage.files.size).toBe(0);
    });

    it.each([
      [{ sizeBytes: 0 }, new BadRequestException('El archivo está vacío.')],
      [
        { sizeBytes: MAX_PATIENT_DOCUMENT_BYTES + 1 },
        new PayloadTooLargeException(FILE_TOO_LARGE_MESSAGE),
      ],
      [
        { sizeBytes: 1.5 },
        new BadRequestException('El tamaño del archivo no es válido.'),
      ],
      [
        { sha256: 'abc' },
        new BadRequestException('La huella SHA-256 del archivo no es válida.'),
      ],
    ])('upload-url %j → %p sin autorizar nada', async (overrides, error) => {
      await expect(ask(pdfFixture(), overrides)).rejects.toThrow(error);
      expect(storage.directUploads.size).toBe(0);
    });

    it('upload-url: paciente ajeno → 404, duplicado vigente → 409, sede no permitida → su error; sin autorizar', async () => {
      await expect(ask(pdfFixture(), { patientId: 'ajeno' })).rejects.toThrow(
        NotFoundException,
      );
      await uploadPdf();
      await expect(ask(pdfFixture())).rejects.toThrow(
        new ConflictException(DUPLICATE_DOCUMENT_MESSAGE),
      );
      const denied = new ForbiddenException('Sede no permitida');
      repo.failResolveLocation = denied;
      await expect(ask(pngFixture())).rejects.toBe(denied);
      expect(storage.directUploads.size).toBe(0);
    });

    it('complete: 19 MB leyendo solo los primeros 64 KB; se mueve a su clave definitiva y se crea la fila', async () => {
      const bytes = Buffer.concat([
        pdfFixture(),
        Buffer.alloc(19 * 1024 * 1024 - pdfFixture().length, 0x20),
      ]);
      const id = await uploaded(bytes);
      const doc = await finish(id, {
        toothNumbers: ['11', '21'],
        clinicalDate: '2026-10-01',
        notes: ' Control ',
      });
      expect(doc).toMatchObject({
        id,
        patientId: PATIENT,
        locationId: LOCATION_ID,
        category: 'REPORT',
        originalName: 'informe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        sha256: sha(bytes),
        toothNumbers: ['11', '21'],
        clinicalDate: '2026-10-01',
        notes: 'Control',
        uploadedById: AUTHOR,
      });
      expect(storage.ranges).toEqual([[pendingKey(id), 0, 64 * 1024]]);
      const finalKey = `patient-documents/${TENANT_ID}/${id}-${sha(bytes).slice(0, 16)}.pdf`;
      expect(repo.rows.get(id)?.storageKey).toBe(finalKey);
      expect([...storage.files.keys()]).toEqual([finalKey]);
      expect(storage.files.get(finalKey)?.contentType).toBe('application/pdf');
    });

    it('complete: un DOCX grande se reconoce leyendo por rango el final (EOCD), no el fichero entero', async () => {
      const bytes = largeDocxFixture(300 * 1024);
      const ticket = await inTenant(() =>
        createUpload.execute(
          PATIENT,
          { sizeBytes: bytes.length, sha256: sha(bytes) },
          AUTHOR,
        ),
      );
      storage.simulateDirectUpload(pendingKey(ticket.documentId), bytes);
      const doc = await finish(ticket.documentId, {
        fileName: 'informe.docx',
        mimeType: '',
      });
      expect(doc.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      const read = storage.ranges.reduce((n, [, a, b]) => n + (b - a), 0);
      expect(read).toBeLessThan(bytes.length / 2);
    });

    it.each([
      [
        'SVG',
        svgFake(),
        'dibujo.svg',
        'image/svg+xml',
        UNSUPPORTED_TYPE_MESSAGE,
      ],
      [
        'PNG como .pdf',
        pngFixture(),
        'informe.pdf',
        'application/pdf',
        TYPE_MISMATCH_MESSAGE,
      ],
    ])(
      'complete: %s → 400 en español, el objeto se borra y no hay fila',
      async (_label, bytes, fileName, mimeType, message) => {
        const id = await uploaded(bytes);
        await expect(finish(id, { fileName, mimeType })).rejects.toThrow(
          new BadRequestException(message),
        );
        expect(storage.deleted).toEqual([pendingKey(id)]);
        expect(storage.files.size).toBe(0);
        expect(repo.rows.size).toBe(0);
      },
    );

    it('complete: tamaño distinto del declarado → 400, se borra y no hay fila', async () => {
      const declared = pdfFixture();
      const ticket = await ask(declared);
      storage.simulateDirectUpload(
        pendingKey(ticket.documentId),
        Buffer.concat([declared, Buffer.from('más')]),
      );
      await expect(finish(ticket.documentId)).rejects.toThrow(
        new BadRequestException(SIZE_MISMATCH_MESSAGE),
      );
      expect(storage.files.size).toBe(0);
      expect(repo.rows.size).toBe(0);
    });

    it.each([
      ['sin checksum del almacén', null],
      ['con otro checksum', Buffer.alloc(32, 7).toString('base64')],
    ])(
      'complete: objeto %s → 400, se borra y no hay fila',
      async (_label, sha256Base64) => {
        const bytes = pdfFixture();
        const ticket = await ask(bytes);
        storage.simulateDirectUpload(pendingKey(ticket.documentId), bytes, {
          sha256Base64,
        });
        await expect(finish(ticket.documentId)).rejects.toThrow(
          new BadRequestException(CHECKSUM_MISMATCH_MESSAGE),
        );
        expect(storage.files.size).toBe(0);
        expect(repo.rows.size).toBe(0);
      },
    );

    it('complete: sin objeto, de otro usuario o de otro paciente → 404 y el objeto ajeno no se toca', async () => {
      await expect(
        finish('9b0f6a52-6f0e-4d51-8a39-2c1f3c6b8d10'),
      ).rejects.toThrow(new NotFoundException(UPLOAD_NOT_FOUND_MESSAGE));
      const id = await uploaded(pdfFixture());
      await expect(finish(id, {}, OTHER_DENTIST)).rejects.toThrow(
        new NotFoundException(UPLOAD_NOT_FOUND_MESSAGE),
      );
      await expect(finish(id, {}, AUTHOR, OTHER_PATIENT)).rejects.toThrow(
        new NotFoundException(UPLOAD_NOT_FOUND_MESSAGE),
      );
      expect(storage.deleted).toEqual([]);
      expect(storage.files.has(pendingKey(id))).toBe(true);
    });

    it('complete: un error del formulario es 400 y conserva el objeto para corregir y reintentar', async () => {
      const id = await uploaded(pdfFixture());
      await expect(finish(id, { category: 'SELFIE' })).rejects.toThrow(
        new BadRequestException('La categoría no es válida.'),
      );
      expect(storage.deleted).toEqual([]);
      await expect(finish(id)).resolves.toMatchObject({ id });
    });

    it('complete: el mismo contenido ya vigente → 409 y se borra el pendiente', async () => {
      const id = await uploaded(pdfFixture());
      await uploadPdf();
      await expect(finish(id)).rejects.toThrow(
        new ConflictException(DUPLICATE_DOCUMENT_MESSAGE),
      );
      expect(storage.files.has(pendingKey(id))).toBe(false);
    });

    it('complete: si el objeto cambia entre la comprobación y la copia → 400 y no hay fila', async () => {
      const bytes = pdfFixture();
      const id = await uploaded(bytes);
      const promote = jest
        .spyOn(storage, 'promote')
        .mockImplementationOnce(() => {
          storage.simulateDirectUpload(pendingKey(id), bytes);
          return InMemoryFileStorage.prototype.promote.call(
            storage,
            pendingKey(id),
            'patient-documents/x/y.pdf',
            'application/pdf',
            '"stale"',
          );
        });
      await expect(finish(id)).rejects.toThrow(
        new BadRequestException(UPLOAD_CHANGED_MESSAGE),
      );
      expect(promote).toHaveBeenCalled();
      expect(repo.rows.size).toBe(0);
    });

    it('complete repetido por el mismo usuario devuelve el documento (created: false) sin tocar el almacén; otro usuario, 404', async () => {
      const id = await uploaded(pdfFixture());
      const first = await inTenant(() =>
        complete.execute(
          PATIENT,
          id,
          { category: 'REPORT', fileName: 'informe.pdf' },
          AUTHOR,
        ),
      );
      expect(first.created).toBe(true);
      const saved = [...storage.saved];
      const again = await inTenant(() =>
        complete.execute(PATIENT, id, { category: 'REPORT' }, AUTHOR),
      );
      expect(again).toEqual({ view: first.view, created: false });
      expect(storage.saved).toEqual(saved);
      await expect(finish(id, {}, OTHER_DENTIST)).rejects.toThrow(
        new NotFoundException(UPLOAD_NOT_FOUND_MESSAGE),
      );
      expect(repo.rows.size).toBe(1);
    });

    it('dos complete a la vez: el que pierde la copia devuelve la fila del que ganó (created: false), no un 400', async () => {
      const bytes = pdfFixture();
      const id = await uploaded(bytes);
      const original = storage.promote.bind(storage);
      jest
        .spyOn(storage, 'promote')
        .mockImplementationOnce(async (from, to, type, etag) => {
          // El otro `complete` gana: mueve el pendiente y crea la fila.
          await inTenant(() =>
            complete.execute(
              PATIENT,
              id,
              { category: 'REPORT', fileName: 'informe.pdf' },
              AUTHOR,
            ),
          );
          return original(from, to, type, etag);
        });
      const loser = await inTenant(() =>
        complete.execute(
          PATIENT,
          id,
          { category: 'REPORT', fileName: 'informe.pdf' },
          AUTHOR,
        ),
      );
      expect(loser.created).toBe(false);
      expect(loser.view.id).toBe(id);
      expect(repo.rows.size).toBe(1);
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
