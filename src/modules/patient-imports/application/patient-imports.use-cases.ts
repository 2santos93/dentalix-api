import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  ClinicCountry,
  DocType,
  PatientImportBatch,
  PatientImportDuplicateMode,
  PatientImportFileFormat,
  PatientImportStatus,
} from '@prisma/client';
import { JobQueue } from '../../jobs/application/job-queue.service';
import { civilDateIn } from '../../../shared/time/civil-day';
import { timeZoneForCountry } from '../../../shared/locations/location-time-zone';
import {
  resolveMapping,
  suggestMapping,
  type ColumnMapping,
  type MappingInput,
} from '../domain/column-mapping';
import { dedupeRows, type CandidateRow } from '../domain/dedupe';
import { issuesCsv, templateCsv } from '../domain/import-csv';
import {
  IMPORT_FIELDS,
  type ImportFieldKey,
  type ImportPatientData,
} from '../domain/import-fields';
import { readImportFile } from '../domain/read-import-file';
import { docKey, validateRow, type RowIssue } from '../domain/row-validation';
import {
  ImportFileError,
  YIELD_EVERY,
  yieldToEventLoop,
} from '../domain/tabular-file';
import {
  BatchLocationError,
  BatchStateError,
  PrismaPatientImportRepository,
  UndoBlockedError,
  importJobKey,
  type ConfirmResult,
} from '../infrastructure/prisma-patient-import.repository';

export const PROCESS_IMPORT_JOB = 'patient-imports.process';
/** Horas que vale un dry-run sin confirmar; después hay que volver a subirlo. */
export const VALIDATION_TTL_HOURS = 24;
/** Días que se conservan los errores por fila (con valores del fichero). */
export const ISSUES_RETENTION_DAYS = 90;
/** Errores y duplicados que viajan en la respuesta; el resto, en errors.csv. */
export const MAX_ISSUES_IN_RESPONSE = 200;
/** Filas del fichero que enseña la previsualización del dry-run. */
export const PREVIEW_ROWS = 10;
export const SAMPLE_ROWS = 5;

export const NOT_FOUND_MESSAGE =
  'Lote de importación no encontrado en esta clínica.';
export const ACTIVE_IMPORT_MESSAGE =
  'Ya hay una importación de pacientes en curso en la clínica: espera a que termine.';
export const EXPIRED_MESSAGE = `La validación caducó (más de ${VALIDATION_TTL_HOURS} h o subiste otro archivo): vuelve a subir el archivo.`;
export const NOTHING_TO_IMPORT_MESSAGE =
  'No hay filas que importar: corrige los errores del archivo y vuelve a subirlo.';
export const REPORT_GONE_MESSAGE = `El informe de errores ya no está disponible: se borra al caducar la validación y a los ${ISSUES_RETENTION_DAYS} días de terminar o deshacer la importación.`;
export const LOCATION_MESSAGE =
  'La sede activa no está disponible: elige una sede activa y vuelve a subir el archivo.';
export const MISSING_FILE_MESSAGE =
  'Falta el archivo: adjúntalo en el campo «file».';

const STATE_MESSAGES: Partial<Record<PatientImportStatus, string>> = {
  QUEUED: 'Este lote ya está confirmado y en cola.',
  RUNNING: 'Este lote se está importando.',
  COMPLETED: 'Este lote ya se importó.',
  FAILED: 'Este lote ya se procesó (con errores).',
  UNDONE: 'Este lote ya se deshizo.',
  EXPIRED: EXPIRED_MESSAGE,
  VALIDATED: 'Este lote aún no se ha importado: no hay nada que deshacer.',
};

/** Campos del asistente (para el contrato de `inspect`). */
export const IMPORT_FIELD_DESCRIPTORS = IMPORT_FIELDS.map((f) => ({
  key: f.key,
  label: f.label,
  required: f.required,
  header: f.header,
}));

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export interface InspectResult {
  fileName: string;
  fileFormat: PatientImportFileFormat;
  encoding: string | null;
  delimiter: string | null;
  headers: string[];
  suggestedMapping: ColumnMapping;
  sampleRows: string[][];
  totalRows: number;
  fields: typeof IMPORT_FIELD_DESCRIPTORS;
}

export interface PreviewRow {
  rowNumber: number;
  status: 'NEW' | 'EXISTING';
  data: ImportPatientData;
}

export interface BatchView {
  id: string;
  status: PatientImportStatus;
  fileName: string;
  fileFormat: PatientImportFileFormat;
  fileSizeBytes: number;
  fileSha256: string;
  locationId: string;
  createdAt: Date;
  createdBy: { id: string; fullName: string | null };
  columnMapping: { columns: ColumnMapping; defaultDocType: DocType | null };
  totals: {
    totalRows: number;
    validRows: number;
    duplicateRows: number;
    errorRows: number;
  };
  progress: {
    preparedRows: number;
    processedRows: number;
    createdCount: number;
    updatedCount: number;
    skippedCount: number;
    failedCount: number;
    percent: number;
  };
  duplicateMode: PatientImportDuplicateMode | null;
  confirmedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  undoneAt: Date | null;
  undoneCreated: number | null;
  undoneFilled: number | null;
  canConfirm: boolean;
  canUndo: boolean;
}

export interface BatchDetail extends BatchView {
  issues: RowIssue[];
  issuesTotal: number;
  preview: PreviewRow[];
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireFile(file: UploadedFile | undefined): UploadedFile {
  if (!file || !file.buffer)
    throw new BadRequestException(MISSING_FILE_MESSAGE);
  return file;
}

async function readFile(file: UploadedFile) {
  try {
    return await readImportFile(file.buffer, file.originalname);
  } catch (err) {
    if (err instanceof ImportFileError)
      throw new BadRequestException(err.message);
    throw err;
  }
}

/** Nombre del fichero para mostrar: sin ruta, sin controles, ≤ 255. */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'archivo';
  // eslint-disable-next-line no-control-regex -- quitar controles es justo lo que se quiere
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (clean || 'archivo').slice(0, 255);
}

function mappingOf(batch: PatientImportBatch): BatchView['columnMapping'] {
  const raw = batch.columnMapping as {
    columns?: ColumnMapping;
    defaultDocType?: DocType | null;
  };
  return {
    columns: raw.columns ?? {},
    defaultDocType: raw.defaultDocType ?? null,
  };
}

/**
 * Casos de uso de la importación de pacientes (DX-107): plantilla, inspección
 * del fichero, dry-run, confirmación (trabajo en segundo plano), consulta,
 * informe de errores, historial y deshacer. Solo ADMIN (controlador).
 */
@Injectable()
export class PatientImportsService {
  constructor(
    private readonly repo: PrismaPatientImportRepository,
    private readonly jobs: JobQueue,
  ) {}

  template(): string {
    return templateCsv();
  }

  /** Cabeceras, mapeo sugerido y unas filas, sin escribir nada. */
  async inspect(file: UploadedFile | undefined): Promise<InspectResult> {
    const f = requireFile(file);
    const parsed = await readFile(f);
    return {
      fileName: safeFileName(f.originalname),
      fileFormat: parsed.format,
      encoding: parsed.encoding ?? null,
      delimiter: parsed.delimiter ?? null,
      headers: parsed.table.headers,
      suggestedMapping: suggestMapping(parsed.table.headers),
      sampleRows: parsed.table.rows.slice(0, SAMPLE_ROWS).map((r) => r.cells),
      totalRows: parsed.table.rows.length,
      fields: IMPORT_FIELD_DESCRIPTORS,
    };
  }

  /**
   * Dry-run: valida cada fila con el mapeo, deduplica contra el fichero y la
   * clínica y guarda el lote VALIDATED con las filas preparadas. NO crea ni
   * toca ningún paciente.
   */
  async dryRun(
    file: UploadedFile | undefined,
    mapping: { columns: ColumnMapping | null; defaultDocType?: DocType },
    actorId: string,
  ): Promise<BatchDetail> {
    const f = requireFile(file);
    const parsed = await readFile(f);
    const input: MappingInput = {
      columns: mapping.columns ?? suggestMapping(parsed.table.headers),
      defaultDocType: mapping.defaultDocType,
    };
    let resolved;
    try {
      resolved = resolveMapping(parsed.table.headers, input);
    } catch (err) {
      if (err instanceof ImportFileError)
        throw new BadRequestException(err.message);
      throw err;
    }
    let location: { id: string; country: string };
    try {
      location = await this.repo.batchLocation();
    } catch (err) {
      if (err instanceof BatchLocationError) {
        throw new BadRequestException(LOCATION_MESSAGE);
      }
      throw err;
    }
    const ctx = {
      countryCode: location.country,
      today: civilDateIn(
        new Date(),
        timeZoneForCountry(location.country as ClinicCountry),
      ),
    };

    const issues: RowIssue[] = [];
    const candidates: CandidateRow[] = [];
    let errorRows = 0;
    let n = 0;
    for (const row of parsed.table.rows) {
      // Cede el hilo: validar 10.000 filas no para al resto de la API.
      if (++n % YIELD_EVERY === 0) await yieldToEventLoop();
      const validated = validateRow(row, resolved, ctx);
      if (validated.data)
        candidates.push({ rowNumber: row.rowNumber, data: validated.data });
      else {
        errorRows += 1;
        issues.push(...validated.issues);
      }
    }
    const keys = [...new Set(candidates.map((c) => docKey(c.data.docNumber)))];
    const existing = await this.repo.existingDocs(keys);
    const deduped = dedupeRows(
      candidates,
      existing,
      resolved.headers.docNumber,
    );
    issues.push(...deduped.issues);
    issues.sort((a, b) => a.row - b.row);

    const prepared = [...deduped.fresh, ...deduped.existing].sort(
      (a, b) => a.rowNumber - b.rowNumber,
    );
    const existingRows = new Set(deduped.existing.map((r) => r.rowNumber));
    const columns: ColumnMapping = {};
    for (const [key, header] of Object.entries(resolved.headers) as [
      ImportFieldKey,
      string,
    ][]) {
      columns[key] = header;
    }
    const batch = await this.repo.createBatch({
      createdById: actorId,
      locationId: location.id,
      fileName: safeFileName(f.originalname),
      fileSha256: sha256(f.buffer),
      fileFormat: parsed.format,
      fileSizeBytes: f.size,
      columnMapping: { columns, defaultDocType: resolved.defaultDocType },
      totalRows: parsed.table.rows.length,
      validRows: deduped.fresh.length,
      duplicateRows: deduped.existing.length + deduped.fileDuplicates,
      errorRows: errorRows + deduped.conflicts,
      issues,
      rows: prepared,
    });
    const view = await this.view(batch);
    return {
      ...view,
      issues: issues.slice(0, MAX_ISSUES_IN_RESPONSE),
      issuesTotal: issues.length,
      preview: prepared.slice(0, PREVIEW_ROWS).map((r) => ({
        rowNumber: r.rowNumber,
        status: existingRows.has(r.rowNumber) ? 'EXISTING' : 'NEW',
        data: r.data,
      })),
    };
  }

  /** Confirma: el lote pasa a la cola y un trabajo lo importa por bloques. */
  async confirm(
    id: string,
    mode: PatientImportDuplicateMode,
    actorId: string,
  ): Promise<BatchDetail> {
    const current = await this.repo.findBatch(id);
    if (!current) throw new NotFoundException(NOT_FOUND_MESSAGE);
    if (current.status === 'VALIDATED' && current.preparedRows === 0) {
      throw new ConflictException(NOTHING_TO_IMPORT_MESSAGE);
    }
    // Un lote anterior atascado (su trabajo murió) no bloquea la clínica.
    await this.repo.reapStuck();
    const active = await this.repo.activeBatchId();
    if (active && active !== id)
      throw new ConflictException(ACTIVE_IMPORT_MESSAGE);
    const validatedAfter = new Date(
      Date.now() - VALIDATION_TTL_HOURS * 3_600_000,
    );
    let result: ConfirmResult | null;
    try {
      result = await this.repo.confirm(id, {
        mode,
        confirmedById: actorId,
        validatedAfter,
        enqueue: async (tx) => {
          await this.jobs.enqueue(
            PROCESS_IMPORT_JOB,
            { batchId: id },
            { tx, idempotencyKey: importJobKey(id) },
          );
        },
      });
    } catch (err) {
      if (err instanceof BatchStateError) {
        throw new ConflictException(
          STATE_MESSAGES[err.status] ?? EXPIRED_MESSAGE,
        );
      }
      // patient_import_batches_one_active_key: otra confirmación a la vez.
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(ACTIVE_IMPORT_MESSAGE);
      }
      throw err;
    }
    if (!result) throw new NotFoundException(NOT_FOUND_MESSAGE);
    if (result.kind === 'expired') {
      // En su propia transacción: la del confirmar no se desharía con él.
      await this.repo.expireBatch(id);
      throw new ConflictException(EXPIRED_MESSAGE);
    }
    return this.detail(result.batch);
  }

  async get(id: string): Promise<BatchDetail> {
    await this.repo.reapStuck();
    const batch = await this.repo.findBatch(id);
    if (!batch) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return this.detail(batch);
  }

  async list(
    page: number,
    pageSize: number,
  ): Promise<{
    items: BatchView[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    await this.repo.reapStuck();
    const { items, total } = await this.repo.listBatches(
      pageSize,
      (page - 1) * pageSize,
    );
    const names = await this.repo.userNames(items.map((b) => b.createdById));
    return {
      items: items.map((b) => this.toView(b, names)),
      total,
      page,
      pageSize,
    };
  }

  async errorsCsv(id: string): Promise<{ fileName: string; csv: string }> {
    const batch = await this.repo.findBatch(id);
    if (!batch) throw new NotFoundException(NOT_FOUND_MESSAGE);
    if (batch.issuesPurgedAt || batch.status === 'EXPIRED') {
      throw new GoneException(REPORT_GONE_MESSAGE);
    }
    const base =
      batch.fileName
        .replace(/\.[^.]*$/, '')
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 80) || 'pacientes';
    return {
      fileName: `errores-${base}.csv`,
      csv: issuesCsv(batch.issues as unknown as RowIssue[]),
    };
  }

  async undo(id: string, actorId: string): Promise<BatchDetail> {
    const current = await this.repo.findBatch(id);
    if (!current) throw new NotFoundException(NOT_FOUND_MESSAGE);
    try {
      await this.repo.undo(id, actorId);
    } catch (err) {
      if (err instanceof UndoBlockedError) {
        throw new ConflictException(
          err.patients === 1
            ? 'No se puede deshacer: 1 paciente de este lote ya tiene citas, historia clínica, planes, pagos u otros datos registrados. Corrígelo desde su ficha.'
            : `No se puede deshacer: ${err.patients} pacientes de este lote ya tienen citas, historia clínica, planes, pagos u otros datos registrados. Corrígelos desde su ficha.`,
        );
      }
      if (err instanceof BatchStateError) {
        throw new ConflictException(
          STATE_MESSAGES[err.status] ?? EXPIRED_MESSAGE,
        );
      }
      throw err;
    }
    return this.get(id);
  }

  private async view(batch: PatientImportBatch): Promise<BatchView> {
    return this.toView(batch, await this.repo.userNames([batch.createdById]));
  }

  private async detail(batch: PatientImportBatch): Promise<BatchDetail> {
    const issues = batch.issues as unknown as RowIssue[];
    return {
      ...(await this.view(batch)),
      issues: issues.slice(0, MAX_ISSUES_IN_RESPONSE),
      issuesTotal: issues.length,
      preview: [],
    };
  }

  private toView(
    batch: PatientImportBatch,
    names: Map<string, string>,
  ): BatchView {
    const validUntil =
      batch.createdAt.getTime() + VALIDATION_TTL_HOURS * 3_600_000;
    return {
      id: batch.id,
      status: batch.status,
      fileName: batch.fileName,
      fileFormat: batch.fileFormat,
      fileSizeBytes: batch.fileSizeBytes,
      fileSha256: batch.fileSha256,
      locationId: batch.locationId,
      createdAt: batch.createdAt,
      createdBy: {
        id: batch.createdById,
        fullName: names.get(batch.createdById) ?? null,
      },
      columnMapping: mappingOf(batch),
      totals: {
        totalRows: batch.totalRows,
        validRows: batch.validRows,
        duplicateRows: batch.duplicateRows,
        errorRows: batch.errorRows,
      },
      progress: {
        preparedRows: batch.preparedRows,
        processedRows: batch.processedRows,
        createdCount: batch.createdCount,
        updatedCount: batch.updatedCount,
        skippedCount: batch.skippedCount,
        failedCount: batch.failedCount,
        percent:
          batch.preparedRows === 0
            ? 100
            : Math.floor((batch.processedRows / batch.preparedRows) * 100),
      },
      duplicateMode: batch.duplicateMode,
      confirmedAt: batch.confirmedAt,
      startedAt: batch.startedAt,
      finishedAt: batch.finishedAt,
      undoneAt: batch.undoneAt,
      undoneCreated: batch.undoneCreated,
      undoneFilled: batch.undoneFilled,
      canConfirm:
        batch.status === 'VALIDATED' &&
        batch.preparedRows > 0 &&
        Date.now() < validUntil,
      canUndo: batch.status === 'COMPLETED' || batch.status === 'FAILED',
    };
  }
}
