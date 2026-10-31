import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ClinicRole, Prisma } from '@prisma/client';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../../shared/storage/file-storage.port';
import {
  hashLocalFile,
  readLocalRange,
} from '../../../../shared/storage/local-file';
import { StorageObjectChangedError } from '../../../../shared/storage/storage-errors';
import {
  CHECKSUM_MISMATCH_MESSAGE,
  EMPTY_FILE_MESSAGE,
  PENDING_META,
  SIZE_MISMATCH_MESSAGE,
  UPLOAD_CHANGED_MESSAGE,
  UPLOAD_NOT_FOUND_MESSAGE,
  checkPendingUpload,
} from '../../../../shared/storage/pending-upload';
import {
  UPLOAD_STORAGE_BUDGET_MS,
  withStorageBudget,
} from '../../../../shared/storage/storage-budget';
import { currentRequestId } from '../../../../shared/observability/request-context';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import {
  PATIENT_REPOSITORY,
  type PatientRepository,
} from '../../../patients/domain/ports/patient-repository.port';
import {
  type ByteRangeSource,
  declaredTypeMatches,
  type DetectedType,
  FILE_TOO_LARGE_MESSAGE,
  isInlineViewable,
  MAX_PATIENT_DOCUMENT_BYTES,
  sniffDocumentFrom,
  TYPE_MISMATCH_MESSAGE,
  UNSUPPORTED_TYPE_MESSAGE,
} from '../../domain/document-content';
import {
  normalizeOriginalName,
  PatientDocumentRuleError,
  pendingStorageKeyFor,
  sha256HexToBase64,
  storageKeyFor,
  validateSha256Hex,
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
  type CreatePatientDocumentInput,
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
/** Vida del POST prefirmado (DX-259); los tests la acortan igual. */
export const PATIENT_DOCUMENT_UPLOAD_TTL = Symbol(
  'PATIENT_DOCUMENT_UPLOAD_TTL',
);

export const MISSING_FILE_MESSAGE = 'Falta el archivo.';
export { EMPTY_FILE_MESSAGE };
export const INVALID_SIZE_MESSAGE = 'El tamaño del archivo no es válido.';
export const DUPLICATE_DOCUMENT_MESSAGE =
  'Este archivo ya está en la ficha del paciente.';
export const DOCUMENT_NOT_FOUND_MESSAGE = 'Documento no encontrado';
export const DOWNLOAD_ONLY_MESSAGE = 'Este tipo solo se puede descargar.';
export const VOID_FORBIDDEN_MESSAGE =
  'Solo quien subió el documento o un administrador puede anularlo.';
export const DOCUMENT_ALREADY_VOIDED_MESSAGE = 'El documento ya está anulado.';
export const SIGNED_CONSENT_PDF_VOID_MESSAGE =
  'Este es el PDF firmado de un consentimiento: es la prueba de la firma y no se puede anular.';

/**
 * Lo que importa del fichero de multer (sin acoplar el caso de uso a él).
 * DX-259: multer lo deja en un temporal en disco (`path`), no en memoria.
 */
export interface UploadedDocumentFile {
  path: string;
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

/**
 * La fila de un documento recién guardado: `created` es false si otra
 * petición ya la había creado (la repetición no se vuelve a auditar).
 */
export interface InsertedDocument {
  view: PatientDocumentView;
  created: boolean;
}

/** Campos del formulario ya validados. */
interface ValidatedDocumentFields {
  category: PatientDocumentCategory;
  toothNumbers: string[];
  notes: string | null;
  clinicalDate: string | null;
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

/** Los dientes del multipart (`"11,21"`), sin validar todavía. */
function splitTeethCsv(csv: string | undefined): string[] {
  return (csv ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

/** Códigos de Prisma de conexión perdida o inalcanzable (no de la consulta). */
const CONNECTION_LOST_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

/**
 * ¿Falló la conexión y no la consulta? Entonces no se sabe si el INSERT se
 * confirmó: la fila puede existir.
 */
function isConnectionLostError(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      CONNECTION_LOST_CODES.has(error.code)) ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError
  );
}

/**
 * Lo común a las dos subidas (multipart y directa, DX-259): validar el
 * formulario, decidir el tipo por contenido, duplicados, sede y la fila.
 */
@Injectable()
export class PatientDocumentWriter {
  private readonly logger = new Logger('PatientDocuments');

  constructor(
    @Inject(PATIENT_DOCUMENT_REPOSITORY)
    private readonly repo: PatientDocumentRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    private readonly tenantContext: TenantContextService,
    @Inject(PATIENT_DOCUMENT_CLOCK) private readonly now: PatientDocumentClock,
  ) {}

  tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /**
   * Reglas del formulario → paciente de la clínica → fecha clínica (con el
   * «hoy» de la sede, que solo se consulta si llega fecha). Lanza 400/404.
   */
  async validateFields(
    patientId: string,
    fields: Pick<
      UploadPatientDocumentFields,
      'category' | 'clinicalDate' | 'notes'
    >,
    teeth: readonly string[] | undefined,
  ): Promise<ValidatedDocumentFields> {
    const category = rule(() => validateCategory(fields.category));
    const toothNumbers = rule(() => validateToothNumbers(teeth));
    const notes = rule(() => validateNotes(fields.notes));
    await assertPatientInClinic(this.patients, patientId);
    let clinicalDate: string | null = null;
    if ((fields.clinicalDate ?? '').trim() !== '') {
      const today = await this.repo.clinicToday(this.now());
      clinicalDate = rule(() =>
        validateClinicalDate(fields.clinicalDate, today),
      );
    }
    return { category, toothNumbers, notes, clinicalDate };
  }

  /** Tipo por contenido que además cuadra con lo declarado, o 400. */
  async detectType(
    source: ByteRangeSource,
    declared: { mimeType?: string; originalName?: string },
  ): Promise<DetectedType> {
    const detected = await sniffDocumentFrom(source);
    if (!detected) throw new BadRequestException(UNSUPPORTED_TYPE_MESSAGE);
    if (!declaredTypeMatches(declared, detected)) {
      throw new BadRequestException(TYPE_MISMATCH_MESSAGE);
    }
    return detected;
  }

  async assertNotDuplicate(patientId: string, sha256: string): Promise<void> {
    if (await this.repo.findActiveBySha256(patientId, sha256)) {
      throw new ConflictException(DUPLICATE_DOCUMENT_MESSAGE);
    }
  }

  resolveWriteLocation(): Promise<{ locationId: string }> {
    return this.repo.resolveWriteLocation();
  }

  /**
   * Crea la fila de un objeto YA guardado en `storageKey`. Si la fila no
   * llega a existir, el objeto se borra (salvo conexión perdida: el INSERT
   * pudo confirmarse). Si otra petición ya creó la fila de ESTE id (dos
   * `complete` a la vez), se devuelve esa y solo se borra el objeto propio
   * cuando no es el de esa fila.
   */
  async insert(input: CreatePatientDocumentInput): Promise<InsertedDocument> {
    let created: PatientDocument;
    try {
      created = await this.repo.create(input);
    } catch (error) {
      if (isConnectionLostError(error)) {
        // El INSERT pudo confirmarse antes de caer la conexión: borrar el
        // objeto dejaría una fila con un 404 permanente. Se conserva (a lo
        // sumo, un huérfano) y se avisa solo con el request id.
        this.logger.warn(
          `Conexión perdida al crear un documento; se conserva el objeto (requestId=${currentRequestId() ?? '-'}, error=${error instanceof Error ? error.name : 'NonError'})`,
        );
        throw error;
      }
      const winner = await this.repo.findById(input.patientId, input.id);
      if (winner?.storageKey !== input.storageKey) {
        await this.discardObject(input.storageKey);
      }
      if (winner) return { view: await this.view(winner), created: false };
      if (error instanceof DuplicateActivePatientDocumentError) {
        throw new ConflictException(DUPLICATE_DOCUMENT_MESSAGE);
      }
      throw error;
    }
    return { view: await this.view(created), created: true };
  }

  async view(doc: PatientDocument): Promise<PatientDocumentView> {
    const [view] = await toViews(this.repo, [doc]);
    return view;
  }

  findById(patientId: string, id: string): Promise<PatientDocument | null> {
    return this.repo.findById(patientId, id);
  }

  /**
   * Borra un objeto que no tiene (ni tendrá) fila: el recién guardado de una
   * subida fallida o el pendiente que no pasó `complete`. Si también falla,
   * manda el error original (el objeto, sin fila, no es alcanzable por la
   * API: su clave solo la conoce la BD, y el pendiente lo borra el ciclo de
   * vida del bucket).
   */
  async discardObject(storageKey: string): Promise<void> {
    try {
      // Excepción justificada al borrado blando: borra el OBJETO del bucket
      // de una subida cuya fila no se creó, no una fila de la BD.
      // eslint-disable-next-line no-restricted-syntax
      await this.storage.delete(storageKey);
    } catch (error) {
      // Best-effort: ver arriba. Se avisa con el request id para buscarlo en
      // el log; nunca la clave (lleva tenant e id del documento) ni el
      // mensaje del adaptador (podría incluirla).
      this.logger.warn(
        `No se pudo borrar el objeto de una subida fallida (requestId=${currentRequestId() ?? '-'}, error=${error instanceof Error ? error.name : 'NonError'})`,
      );
    }
  }
}

@Injectable()
export class UploadPatientDocumentUseCase {
  constructor(
    private readonly writer: PatientDocumentWriter,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
  ) {}

  /**
   * Sube un documento a la ficha por la API (multipart). DX-259: el fichero
   * llega a un temporal en disco (multer), no a memoria; se lee por rangos
   * para el tipo, se calcula su huella en streaming y se sube al almacén en
   * streaming. La web usa la subida directa (`upload-url` + `complete`).
   *
   * El CONTENIDO decide el tipo (lista blanca); lo que dice el cliente solo
   * puede coincidir o no. Orden: reglas del formulario → paciente de la
   * clínica → contenido → duplicado vigente → objeto en el almacén → fila.
   * Autor (token), sede (contexto) y hora de la subida (BD) nunca salen del
   * cuerpo.
   */
  /** Revisión M-1: con un presupuesto de almacén que cabe en el proxy. */
  execute(
    patientId: string,
    fields: UploadPatientDocumentFields,
    file: UploadedDocumentFile | undefined,
    uploadedById: string,
  ): Promise<PatientDocumentView> {
    return withStorageBudget(UPLOAD_STORAGE_BUDGET_MS, () =>
      this.upload(patientId, fields, file, uploadedById),
    );
  }

  private async upload(
    patientId: string,
    fields: UploadPatientDocumentFields,
    file: UploadedDocumentFile | undefined,
    uploadedById: string,
  ): Promise<PatientDocumentView> {
    if (!file) throw new BadRequestException(MISSING_FILE_MESSAGE);
    // Multer ya corta en 20 MB; esto cubre a cualquier otro llamador.
    if (file.size > MAX_PATIENT_DOCUMENT_BYTES) {
      throw new PayloadTooLargeException(FILE_TOO_LARGE_MESSAGE);
    }
    if (file.size === 0) throw new BadRequestException(EMPTY_FILE_MESSAGE);

    const valid = await this.writer.validateFields(
      patientId,
      fields,
      splitTeethCsv(fields.toothNumbers),
    );
    const detected = await this.writer.detectType(
      {
        size: file.size,
        read: (start, end) => readLocalRange(file.path, start, end),
      },
      { mimeType: file.mimetype, originalName: file.originalname },
    );
    const sha256 = (await hashLocalFile(file.path)).sha256.toString('hex');
    await this.writer.assertNotDuplicate(patientId, sha256);

    // La sede se resuelve ANTES de guardar el objeto: si falla (sede no
    // permitida, BD caída), el bucket no se toca.
    const { locationId } = await this.writer.resolveWriteLocation();
    const id = randomUUID();
    const storageKey = storageKeyFor(this.writer.tenantId(), id, detected);
    await this.storage.saveFile(storageKey, file.path, detected);
    const { view } = await this.writer.insert({
      id,
      patientId,
      locationId,
      ...valid,
      originalName: normalizeOriginalName(file.originalname),
      mimeType: detected,
      sizeBytes: file.size,
      sha256,
      storageKey,
      uploadedById,
    });
    return view;
  }
}

/** Lo que declara el navegador al pedir la subida directa (DX-259). */
export interface PatientDocumentUploadRequest {
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  /** SHA-256 del contenido en hex. */
  sha256?: string;
}

/** La autorización de subida directa que recibe el navegador. */
export interface PatientDocumentUploadTicket {
  documentId: string;
  method: 'POST';
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
}

/** Metadatos `x-amz-meta-*` que fija la API en el objeto pendiente. */
const META = {
  ...PENDING_META,
  patientId: 'patient-id',
} as const;

// Los mensajes de la subida directa viven en `shared/storage/pending-upload`
// (los comparten los soportes de gastos, DX-274); se siguen exponiendo aquí.
export {
  CHECKSUM_MISMATCH_MESSAGE,
  SIZE_MISMATCH_MESSAGE,
  UPLOAD_CHANGED_MESSAGE,
  UPLOAD_NOT_FOUND_MESSAGE,
};

/**
 * QA D3: código del 400 de `complete` cuando el CONTENIDO no vale (vacío, más
 * de 20 MB, tipo no admitido o que no coincide con el declarado). Volver a
 * subir el mismo fichero daría lo mismo: la web no ofrece «Reintentar».
 */
export const DOCUMENT_CONTENT_REJECTED_CODE = 'DOCUMENT_CONTENT_REJECTED';

function contentRejected(message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: DOCUMENT_CONTENT_REJECTED_CODE,
    message,
  });
}

@Injectable()
export class CreatePatientDocumentUploadUseCase {
  constructor(
    private readonly writer: PatientDocumentWriter,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    @Inject(PATIENT_DOCUMENT_UPLOAD_TTL)
    private readonly ttlSeconds: number,
  ) {}

  /**
   * DX-259 (OPS-038): autoriza al navegador a subir UN fichero directamente
   * al almacén, sin pasar por el proxy de la web ni por la memoria de la API.
   * La clave la fija la API (`pending/<tenant>/<id>`), el tamaño va de 1 B a
   * 20 MB, el SHA-256 declarado es obligatorio (el almacén rechaza otro
   * contenido) y el autor y el paciente quedan en metadatos firmados. Nada
   * llega a la ficha hasta `complete`. Antes de autorizar: tamaño, huella,
   * paciente de la clínica, duplicado vigente (409) y sede de escritura.
   */
  async execute(
    patientId: string,
    request: PatientDocumentUploadRequest,
    uploadedById: string,
  ): Promise<PatientDocumentUploadTicket> {
    const size = request.sizeBytes;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
      throw new BadRequestException(INVALID_SIZE_MESSAGE);
    }
    if (size > MAX_PATIENT_DOCUMENT_BYTES) {
      throw new PayloadTooLargeException(FILE_TOO_LARGE_MESSAGE);
    }
    if (size === 0) throw new BadRequestException(EMPTY_FILE_MESSAGE);
    const sha256 = rule(() => validateSha256Hex(request.sha256));
    await assertPatientInClinic(this.patients, patientId);
    await this.writer.assertNotDuplicate(patientId, sha256);
    await this.writer.resolveWriteLocation();

    const documentId = randomUUID();
    const target = await this.storage.createDirectUpload(
      pendingStorageKeyFor(this.writer.tenantId(), documentId),
      {
        maxBytes: MAX_PATIENT_DOCUMENT_BYTES,
        sha256Base64: sha256HexToBase64(sha256),
        metadata: {
          [META.uploadedBy]: uploadedById,
          [META.patientId]: patientId,
          [META.size]: String(size),
          [META.sha256]: sha256,
        },
        ttlSeconds: this.ttlSeconds,
      },
    );
    return {
      documentId,
      method: target.method,
      url: target.url,
      fields: target.fields,
      expiresAt: target.expiresAt.toISOString(),
      maxBytes: MAX_PATIENT_DOCUMENT_BYTES,
    };
  }
}

/**
 * Cuerpo de `complete`: los campos del formulario (como en el multipart, pero
 * los dientes en una lista) y el nombre y el tipo que declara el navegador.
 */
export interface CompletePatientDocumentFields {
  category?: string;
  /** `YYYY-MM-DD`. */
  clinicalDate?: string;
  toothNumbers?: string[];
  notes?: string;
  fileName?: string;
  mimeType?: string;
}

@Injectable()
export class CompletePatientDocumentUploadUseCase {
  constructor(
    private readonly writer: PatientDocumentWriter,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
  ) {}

  /**
   * DX-259: el navegador ya dejó el fichero en `pending/<tenant>/<id>`.
   * Orden: reglas del formulario (400 sin tocar el objeto: se puede corregir
   * y repetir) → paciente → objeto pendiente de ESTE usuario y paciente (404
   * si no) → tamaño, SHA-256 (`HeadObject`) y tipo por contenido (los
   * primeros 64 KB con `Range`) → duplicado → sede → se mueve a su clave
   * definitiva → fila. Si el contenido no vale (tipo, tamaño o huella), el
   * objeto se borra y la respuesta es 400 en español; un duplicado, 409.
   * Repetir `complete` de un documento ya creado (el mismo usuario) lo
   * devuelve con `created: false` (no se vuelve a auditar); otro usuario, 404.
   */
  execute(
    patientId: string,
    documentId: string,
    fields: CompletePatientDocumentFields,
    uploadedById: string,
  ): Promise<InsertedDocument> {
    // Revisión M-1: todas sus operaciones (HeadObject, Range, CopyObject)
    // comparten un presupuesto que cabe en los 30 s del proxy de la web.
    return withStorageBudget(UPLOAD_STORAGE_BUDGET_MS, () =>
      this.complete(patientId, documentId, fields, uploadedById),
    );
  }

  private async complete(
    patientId: string,
    documentId: string,
    fields: CompletePatientDocumentFields,
    uploadedById: string,
  ): Promise<InsertedDocument> {
    const valid = await this.writer.validateFields(
      patientId,
      fields,
      fields.toothNumbers,
    );
    const existing = await this.alreadyCompleted(
      patientId,
      documentId,
      uploadedById,
    );
    if (existing) return existing;

    const pendingKey = pendingStorageKeyFor(this.writer.tenantId(), documentId);
    /**
     * Revisión I-3: dos `complete` del mismo documento a la vez (doble clic o
     * reintento tras el `proxyTimeout`). El pendiente solo se borra DESPUÉS de
     * crear la fila, así que si este ya no lo ve (o ve la huella como
     * duplicada) es porque el otro ganó: se devuelve su fila (`created:
     * false`), nunca «vuelve a subirlo» ni «ya está en la ficha».
     */
    const winnerOr = async (
      lost: () => Promise<never>,
    ): Promise<InsertedDocument> =>
      (await this.alreadyCompleted(patientId, documentId, uploadedById)) ??
      lost();

    const reject = async (
      error: BadRequestException | ConflictException,
    ): Promise<never> => {
      await this.writer.discardObject(pendingKey);
      throw error;
    };

    const checked = await checkPendingUpload(this.storage, pendingKey, {
      maxBytes: MAX_PATIENT_DOCUMENT_BYTES,
      tooLargeMessage: FILE_TOO_LARGE_MESSAGE,
      // De otro usuario o paciente no se toca (ni se dice cuál de las cosas es).
      isOwner: (meta) =>
        meta[META.uploadedBy] === uploadedById &&
        meta[META.patientId] === patientId,
      contentRejected,
    });
    if (!checked.ok && checked.reason === 'NOT_FOUND') {
      return winnerOr(() =>
        Promise.reject(new NotFoundException(UPLOAD_NOT_FOUND_MESSAGE)),
      );
    }
    if (!checked.ok) return reject(checked.error);
    const { info, declaredSha } = checked;

    let detected: DetectedType;
    try {
      detected = await this.writer.detectType(
        {
          size: info.size,
          read: (start, end) =>
            this.storage.readRange(pendingKey, start, end, info.etag),
        },
        { mimeType: fields.mimeType, originalName: fields.fileName },
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        return reject(contentRejected(error.message));
      }
      if (error instanceof StorageObjectChangedError) {
        return winnerOr(() =>
          reject(new BadRequestException(UPLOAD_CHANGED_MESSAGE)),
        );
      }
      throw error;
    }
    try {
      await this.writer.assertNotDuplicate(patientId, declaredSha);
    } catch (error) {
      if (error instanceof ConflictException) {
        return winnerOr(() => reject(error));
      }
      throw error;
    }

    const { locationId } = await this.writer.resolveWriteLocation();
    const storageKey = storageKeyFor(
      this.writer.tenantId(),
      documentId,
      detected,
      declaredSha,
    );
    try {
      await this.storage.copyVersion(
        pendingKey,
        storageKey,
        detected,
        info.etag,
      );
    } catch (error) {
      if (error instanceof StorageObjectChangedError) {
        // El otro `complete` ya creó la fila y borró el pendiente: esa fila,
        // sin volver a auditar.
        return winnerOr(() =>
          reject(new BadRequestException(UPLOAD_CHANGED_MESSAGE)),
        );
      }
      throw error;
    }
    // Si el otro `complete` insertó antes, `insert` devuelve su fila.
    const inserted = await this.writer.insert({
      id: documentId,
      patientId,
      locationId,
      ...valid,
      originalName: normalizeOriginalName(fields.fileName ?? ''),
      mimeType: detected,
      sizeBytes: info.size,
      sha256: declaredSha,
      storageKey,
      uploadedById,
    });
    // Revisión M-2: el pendiente, ya con fila, se borra sin esperar ni fallar
    // (`discardObject` solo avisa); si no se puede, lo borra el ciclo de vida
    // del bucket (24 h en `patient-documents/pending/`).
    void this.writer.discardObject(pendingKey);
    return inserted;
  }

  /**
   * El documento ya creado por ESTE usuario (repetir `complete` lo devuelve,
   * `created: false`); de otro usuario, 404 como si no existiera la subida.
   */
  private async alreadyCompleted(
    patientId: string,
    documentId: string,
    uploadedById: string,
  ): Promise<InsertedDocument | null> {
    const existing = await this.writer.findById(patientId, documentId);
    if (!existing) return null;
    if (existing.uploadedById !== uploadedById) {
      throw new NotFoundException(UPLOAD_NOT_FOUND_MESSAGE);
    }
    return { view: await this.writer.view(existing), created: false };
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
    if (outcome === 'SIGNED_CONSENT_PDF') {
      throw new ConflictException(SIGNED_CONSENT_PDF_VOID_MESSAGE);
    }
    const voided = await this.repo.findById(patientId, id);
    if (!voided) throw new NotFoundException(DOCUMENT_NOT_FOUND_MESSAGE);
    const [view] = await toViews(this.repo, [voided]);
    return view;
  }
}
