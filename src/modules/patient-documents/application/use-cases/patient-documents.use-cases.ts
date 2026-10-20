import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../../shared/storage/file-storage.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import {
  PATIENT_REPOSITORY,
  type PatientRepository,
} from '../../../patients/domain/ports/patient-repository.port';
import {
  declaredTypeMatches,
  FILE_TOO_LARGE_MESSAGE,
  isInlineViewable,
  MAX_PATIENT_DOCUMENT_BYTES,
  sniffDocument,
  TYPE_MISMATCH_MESSAGE,
  UNSUPPORTED_TYPE_MESSAGE,
} from '../../domain/document-content';
import {
  normalizeOriginalName,
  PatientDocumentRuleError,
  sha256Hex,
  storageKeyFor,
  validateCategory,
  validateClinicalDate,
  validateNotes,
  validateToothNumbers,
  validateVoidReason,
} from '../../domain/document-rules';
import type {
  PatientDocument,
  PatientDocumentCategory,
} from '../../domain/entities/patient-document.entity';
import {
  DuplicateActivePatientDocumentError,
  PATIENT_DOCUMENT_REPOSITORY,
  type PatientDocumentFilters,
  type PatientDocumentRepository,
} from '../../domain/ports/patient-document-repository.port';

export type PatientDocumentClock = () => Date;
export const PATIENT_DOCUMENT_CLOCK = Symbol('PATIENT_DOCUMENT_CLOCK');
/**
 * Vida de las URL firmadas en segundos. En producción
 * `PATIENT_DOCUMENT_URL_TTL_SECONDS` (5 min); los e2e la acortan con
 * `overrideProvider` para probar la caducidad.
 */
export const PATIENT_DOCUMENT_URL_TTL = Symbol('PATIENT_DOCUMENT_URL_TTL');

export const MISSING_FILE_MESSAGE = 'Falta el archivo.';
export const EMPTY_FILE_MESSAGE = 'El archivo está vacío.';
export const DUPLICATE_DOCUMENT_MESSAGE =
  'Este archivo ya está en la ficha del paciente.';
export const DOCUMENT_NOT_FOUND_MESSAGE = 'Documento no encontrado';
export const DOWNLOAD_ONLY_MESSAGE = 'Este tipo solo se puede descargar.';
export const VOID_FORBIDDEN_MESSAGE =
  'Solo quien subió el documento o un administrador puede anularlo.';
export const DOCUMENT_ALREADY_VOIDED_MESSAGE = 'El documento ya está anulado.';

/** Lo que importa del fichero de multer (sin acoplar el caso de uso a él). */
export interface UploadedDocumentFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/** Campos de texto del multipart, tal como llegan. */
export interface UploadPatientDocumentFields {
  category?: string;
  /** `YYYY-MM-DD`. */
  clinicalDate?: string;
  /** CSV de dientes FDI: `"11,21"`. */
  toothNumbers?: string;
  notes?: string;
}

/**
 * Lo que ve la API de un documento: sin `tenantId` ni `storageKey` (la clave
 * del almacén no sale nunca; se pide una URL firmada), con los nombres del
 * autor y de quien lo anuló y si se puede abrir en el navegador.
 */
export interface PatientDocumentView {
  id: string;
  patientId: string;
  locationId: string;
  category: PatientDocumentCategory;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  clinicalDate: string | null;
  toothNumbers: string[];
  notes: string | null;
  uploadedById: string;
  uploadedByName: string | null;
  uploadedAt: Date;
  inlineViewable: boolean;
  voidedAt: Date | null;
  voidedById: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface PatientDocumentUrl {
  url: string;
  expiresAt: string;
  disposition: 'inline' | 'attachment';
}

/** Las reglas puras fallan con su mensaje en español: 400 tal cual. */
function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof PatientDocumentRuleError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

function toView(
  doc: PatientDocument,
  names: Map<string, string>,
): PatientDocumentView {
  return {
    id: doc.id,
    patientId: doc.patientId,
    locationId: doc.locationId,
    category: doc.category,
    originalName: doc.originalName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    sha256: doc.sha256,
    clinicalDate: doc.clinicalDate,
    toothNumbers: doc.toothNumbers,
    notes: doc.notes,
    uploadedById: doc.uploadedById,
    uploadedByName: names.get(doc.uploadedById) ?? null,
    uploadedAt: doc.uploadedAt,
    inlineViewable: isInlineViewable(doc.mimeType),
    voidedAt: doc.voidedAt,
    voidedById: doc.voidedById,
    voidedByName: doc.voidedById ? (names.get(doc.voidedById) ?? null) : null,
    voidReason: doc.voidReason,
  };
}

async function toViews(
  repo: PatientDocumentRepository,
  docs: PatientDocument[],
): Promise<PatientDocumentView[]> {
  const ids = new Set<string>();
  for (const doc of docs) {
    ids.add(doc.uploadedById);
    if (doc.voidedById) ids.add(doc.voidedById);
  }
  const names =
    ids.size > 0 ? await repo.userNames([...ids]) : new Map<string, string>();
  return docs.map((doc) => toView(doc, names));
}

async function requireDocument(
  repo: PatientDocumentRepository,
  patients: PatientRepository,
  patientId: string,
  id: string,
): Promise<PatientDocument> {
  await assertPatientInClinic(patients, patientId);
  const doc = await repo.findById(patientId, id);
  if (!doc) throw new NotFoundException(DOCUMENT_NOT_FOUND_MESSAGE);
  return doc;
}

function parseTeethCsv(csv: string | undefined): string[] {
  const parts = (csv ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  return rule(() => validateToothNumbers(parts));
}

@Injectable()
export class UploadPatientDocumentUseCase {
  constructor(
    @Inject(PATIENT_DOCUMENT_REPOSITORY)
    private readonly repo: PatientDocumentRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    private readonly tenantContext: TenantContextService,
    @Inject(PATIENT_DOCUMENT_CLOCK) private readonly now: PatientDocumentClock,
  ) {}

  /**
   * Sube un documento a la ficha. El CONTENIDO decide el tipo (lista blanca);
   * lo que dice el cliente solo puede coincidir o no. Orden: reglas del
   * formulario → paciente de la clínica → contenido → duplicado vigente →
   * objeto en el almacén → fila. Autor (token), sede (contexto) y hora de la
   * subida (BD) nunca salen del cuerpo.
   */
  async execute(
    patientId: string,
    fields: UploadPatientDocumentFields,
    file: UploadedDocumentFile | undefined,
    uploadedById: string,
  ): Promise<PatientDocumentView> {
    if (!file) throw new BadRequestException(MISSING_FILE_MESSAGE);
    const bytes = file.buffer;
    // Multer ya corta en 20 MB; esto cubre a cualquier otro llamador.
    if (bytes.length > MAX_PATIENT_DOCUMENT_BYTES) {
      throw new PayloadTooLargeException(FILE_TOO_LARGE_MESSAGE);
    }
    if (bytes.length === 0) throw new BadRequestException(EMPTY_FILE_MESSAGE);

    const category = rule(() => validateCategory(fields.category));
    const toothNumbers = parseTeethCsv(fields.toothNumbers);
    const notes = rule(() => validateNotes(fields.notes));
    await assertPatientInClinic(this.patients, patientId);
    // El «hoy» de la sede solo se consulta si llega fecha clínica.
    let clinicalDate: string | null = null;
    if ((fields.clinicalDate ?? '').trim() !== '') {
      const today = await this.repo.clinicToday(this.now());
      clinicalDate = rule(() =>
        validateClinicalDate(fields.clinicalDate, today),
      );
    }

    const detected = sniffDocument(bytes);
    if (!detected) throw new BadRequestException(UNSUPPORTED_TYPE_MESSAGE);
    if (
      !declaredTypeMatches(
        { mimeType: file.mimetype, originalName: file.originalname },
        detected,
      )
    ) {
      throw new BadRequestException(TYPE_MISMATCH_MESSAGE);
    }

    const sha256 = sha256Hex(bytes);
    if (await this.repo.findActiveBySha256(patientId, sha256)) {
      throw new ConflictException(DUPLICATE_DOCUMENT_MESSAGE);
    }

    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    const id = randomUUID();
    const storageKey = storageKeyFor(tenantId, id, detected);
    await this.storage.save(storageKey, bytes, detected);

    let created: PatientDocument;
    try {
      created = await this.repo.create({
        id,
        patientId,
        category,
        originalName: normalizeOriginalName(file.originalname),
        mimeType: detected,
        sizeBytes: bytes.length,
        sha256,
        storageKey,
        clinicalDate,
        toothNumbers,
        notes,
        uploadedById,
      });
    } catch (error) {
      await this.discardObject(storageKey);
      if (error instanceof DuplicateActivePatientDocumentError) {
        throw new ConflictException(DUPLICATE_DOCUMENT_MESSAGE);
      }
      throw error;
    }
    const [view] = await toViews(this.repo, [created]);
    return view;
  }

  /**
   * La fila no llegó a existir: el objeto recién guardado quedaría huérfano
   * (y con datos clínicos) en el bucket. Se intenta borrar; si también falla,
   * manda el error del INSERT (el objeto, sin fila, no es alcanzable por la
   * API: su clave solo la conoce la BD).
   */
  private async discardObject(storageKey: string): Promise<void> {
    try {
      // Excepción justificada al borrado blando: borra el OBJETO del bucket
      // de una subida cuya fila no se creó, no una fila de la BD.
      // eslint-disable-next-line no-restricted-syntax
      await this.storage.delete(storageKey);
    } catch {
      // Best-effort: ver arriba.
    }
  }
}

@Injectable()
export class ListPatientDocumentsUseCase {
  constructor(
    @Inject(PATIENT_DOCUMENT_REPOSITORY)
    private readonly repo: PatientDocumentRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
  ) {}

  /** Más reciente primero; incluye anulados. 404 si el paciente no es de aquí. */
  async execute(
    patientId: string,
    query: { category?: string; tooth?: string },
  ): Promise<PatientDocumentView[]> {
    const filters: PatientDocumentFilters = {};
    if (query.category) {
      filters.category = rule(() => validateCategory(query.category));
    }
    if (query.tooth) {
      [filters.tooth] = rule(() => validateToothNumbers([query.tooth!]));
    }
    await assertPatientInClinic(this.patients, patientId);
    return toViews(
      this.repo,
      await this.repo.listByPatient(patientId, filters),
    );
  }
}

@Injectable()
export class GetPatientDocumentUseCase {
  constructor(
    @Inject(PATIENT_DOCUMENT_REPOSITORY)
    private readonly repo: PatientDocumentRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
  ) {}

  async execute(patientId: string, id: string): Promise<PatientDocumentView> {
    const doc = await requireDocument(this.repo, this.patients, patientId, id);
    const [view] = await toViews(this.repo, [doc]);
    return view;
  }
}

@Injectable()
export class GetPatientDocumentUrlUseCase {
  constructor(
    @Inject(PATIENT_DOCUMENT_REPOSITORY)
    private readonly repo: PatientDocumentRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    @Inject(PATIENT_DOCUMENT_CLOCK) private readonly now: PatientDocumentClock,
    @Inject(PATIENT_DOCUMENT_URL_TTL) private readonly ttlSeconds: number,
  ) {}

  /**
   * URL firmada de corta vida para ver (`inline`, solo PDF/JPEG/PNG) o
   * descargar (`attachment`, cualquiera, también anulado). Disposición, nombre
   * original y tipo DETECTADO van firmados en la URL.
   */
  async execute(
    patientId: string,
    id: string,
    disposition: 'inline' | 'attachment',
  ): Promise<PatientDocumentUrl> {
    const doc = await requireDocument(this.repo, this.patients, patientId, id);
    if (disposition === 'inline' && !isInlineViewable(doc.mimeType)) {
      throw new BadRequestException(DOWNLOAD_ONLY_MESSAGE);
    }
    const issuedAt = this.now();
    const url = await this.storage.getSignedUrl(
      doc.storageKey,
      this.ttlSeconds,
      { disposition, filename: doc.originalName, contentType: doc.mimeType },
    );
    return {
      url,
      expiresAt: new Date(
        issuedAt.getTime() + this.ttlSeconds * 1000,
      ).toISOString(),
      disposition,
    };
  }
}

@Injectable()
export class VoidPatientDocumentUseCase {
  constructor(
    @Inject(PATIENT_DOCUMENT_REPOSITORY)
    private readonly repo: PatientDocumentRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
  ) {}

  /**
   * Lo anula quien lo subió o un ADMIN, con motivo; una sola vez. El
   * documento sigue en la ficha (tachado) y descargable: no se borra nada.
   */
  async execute(
    patientId: string,
    id: string,
    reason: string | undefined,
    actor: { userId: string; role: ClinicRole },
  ): Promise<PatientDocumentView> {
    const trimmed = rule(() => validateVoidReason(reason));
    const current = await requireDocument(
      this.repo,
      this.patients,
      patientId,
      id,
    );
    if (
      actor.role !== ClinicRole.ADMIN &&
      current.uploadedById !== actor.userId
    ) {
      throw new ForbiddenException(VOID_FORBIDDEN_MESSAGE);
    }
    if (current.voidedAt) {
      throw new ConflictException(DOCUMENT_ALREADY_VOIDED_MESSAGE);
    }
    const outcome = await this.repo.void(id, {
      voidedById: actor.userId,
      reason: trimmed,
    });
    if (outcome === 'NOT_FOUND') {
      throw new NotFoundException(DOCUMENT_NOT_FOUND_MESSAGE);
    }
    if (outcome === 'ALREADY_VOIDED') {
      throw new ConflictException(DOCUMENT_ALREADY_VOIDED_MESSAGE);
    }
    const voided = await this.repo.findById(patientId, id);
    if (!voided) throw new NotFoundException(DOCUMENT_NOT_FOUND_MESSAGE);
    const [view] = await toViews(this.repo, [voided]);
    return view;
  }
}
