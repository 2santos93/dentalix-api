import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  DocumentType,
  PatientImportDuplicateMode,
  PatientImportFileFormat,
  PatientImportStatus,
} from '@prisma/client';
import { JobQueue } from '../../jobs/application/job-queue.service';
import { DocumentTypeNamesReader } from '../../patients/domain/ports/document-type-names-repository.port';
import { civilDateIn } from '../../../shared/time/civil-day';
import {
  readStoredColumnMapping,
  resolveMapping,
  storedColumnMapping,
  suggestMapping,
  type ColumnMapping,
  type MappingInput,
} from '../domain/column-mapping';
import { dedupeRows, type CandidateRow } from '../domain/dedupe';
import { issuesCsv, templateCsv } from '../domain/import-csv';
import {
  aggregateBalances,
  balanceTemplateCsv,
  resolveBalanceColumns,
  totalsByCurrency,
  validateBalanceRow,
  type BalanceCandidate,
  type CurrencyTotal,
} from '../domain/opening-balance-sheet';
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
import { locationCurrencyRequired } from '../../../shared/locations/reference-location';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import { callingCodeOfCountry } from '../../../shared/phone/country-calling-code';
import {
  BatchLocationError,
  BatchStateError,
  type BatchLocation,
  type LocationFormatSettings,
  PrismaPatientImportRepository,
  UndoBlockedError,
  importJobKey,
  type BatchRow,
  type ConfirmResult,
  type ImportedBalanceTotal,
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
export const BALANCES_NOT_EDITABLE_MESSAGE =
  'La hoja de saldos solo se puede cambiar antes de confirmar la importación.';
export const BALANCE_REPORT_GONE_MESSAGE =
  'Este lote no tiene hoja de saldos o su informe ya no está disponible.';

/** Mensaje del deshacer bloqueado (pacientes con actividad o saldos con abonos). */
export function undoBlockedMessage(
  err: UndoBlockedError,
  withBalances = false,
): string {
  if (err.balances > 0) {
    return err.balances === 1
      ? 'No se puede deshacer: 1 saldo migrado de este lote ya tiene abonos. Anula esos abonos antes de deshacer.'
      : `No se puede deshacer: ${err.balances} saldos migrados de este lote ya tienen abonos. Anula esos abonos antes de deshacer.`;
  }
  const hint = withBalances
    ? ' Si solo quieres quitar sus saldos migrados, usa «Retirar saldos migrados».'
    : '';
  return err.patients === 1
    ? `No se puede deshacer: 1 paciente de este lote ya tiene citas, historia clínica, planes, pagos, saldos de otra importación u otros datos registrados. Corrígelo desde su ficha.${hint}`
    : `No se puede deshacer: ${err.patients} pacientes de este lote ya tienen citas, historia clínica, planes, pagos, saldos de otra importación u otros datos registrados. Corrígelos desde su ficha.${hint}`;
}

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

/** Total por moneda en unidades de la moneda (no céntimos). */
export interface BalanceCurrencyTotal {
  currency: string;
  rows: number;
  amount: number;
}

/** Hoja de saldos del lote (DX-262). */
export interface BalancesView {
  fileName: string;
  fileFormat: PatientImportFileFormat;
  fileSizeBytes: number;
  fileSha256: string;
  totalRows: number;
  /** Filas que se importan (las sumadas a otra incluidas). */
  validRows: number;
  errorRows: number;
  mergedRows: number;
  /** Saldos a crear: uno por paciente y moneda. */
  preparedCount: number;
  /** «Añadir aunque ya tenga saldo migrado» marcado al subir la hoja. */
  addToExisting: boolean;
  /** Todas las filas con importe y moneda legibles, por moneda. */
  fileTotals: BalanceCurrencyTotal[];
  /** Lo que se importa, por moneda. */
  validTotals: BalanceCurrencyTotal[];
  /** Saldos migrados vivos del lote, por moneda (lo importado de verdad). */
  imported: { currency: string; count: number; amount: number }[];
  progress: {
    processed: number;
    created: number;
    /** No creados: su paciente no existía al importar. */
    skipped: number;
    /** No creados: su documento era de varios pacientes vivos. */
    ambiguous: number;
    /** No creados: ya tenía un saldo migrado vivo en esa moneda (QA D1). */
    existing: number;
  };
  undoneCount: number | null;
  /** Lo que retiró de verdad el deshacer, por moneda. */
  undoneTotals: BalanceCurrencyTotal[];
  /** Hay saldos vivos y el lote está terminado: se pueden retirar solos. */
  canUndo: boolean;
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
  columnMapping: {
    columns: ColumnMapping;
    defaultDocType: DocumentType | null;
  };
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
  /** El informe de errores sigue disponible (ni caducado ni purgado). */
  reportAvailable: boolean;
  /** Hoja de saldos (DX-262); null si el lote no trae. */
  balances: BalancesView | null;
}

export interface BatchDetail extends BatchView {
  issues: RowIssue[];
  issuesTotal: number;
  preview: PreviewRow[];
  /** Errores y avisos de la hoja de saldos (los primeros). */
  balanceIssues: RowIssue[];
  balanceIssuesTotal: number;
}

const fromCents = (cents: number) => Math.round(cents) / 100;

function toAmounts(raw: unknown): BalanceCurrencyTotal[] {
  return ((raw ?? []) as CurrencyTotal[]).map((t) => ({
    currency: t.currency,
    rows: t.rows,
    amount: fromCents(t.cents),
  }));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireFile(file: UploadedFile | undefined): UploadedFile {
  if (!file || !file.buffer)
    throw new BadRequestException(MISSING_FILE_MESSAGE);
  return file;
}

/**
 * 400 con el texto de un `ImportFileError` en el formato de la sede del lote
 * (G1-B); el formato se pide solo si el texto lleva cifras (I4).
 */
function fileErrorOf(err: unknown, location: LocationFormatSettings): unknown {
  if (!(err instanceof ImportFileError)) return err;
  return new BadRequestException(
    err.render(() => requireLocationFormat(location)),
  );
}

async function readFile(file: UploadedFile, location: LocationFormatSettings) {
  try {
    return await readImportFile(file.buffer, file.originalname);
  } catch (err) {
    throw fileErrorOf(err, location);
  }
}

/** Nombre del fichero para mostrar: sin ruta, sin controles, ≤ 255. */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'archivo';
  // eslint-disable-next-line no-control-regex -- quitar controles es justo lo que se quiere
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (clean || 'archivo').slice(0, 255);
}

/** Mapeo del lote con el tipo por defecto genérico (DX-327, pre-flight M3). */
export function mappingOf(batch: BatchRow): BatchView['columnMapping'] {
  return readStoredColumnMapping(batch.columnMapping);
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
    private readonly documentTypeNames: DocumentTypeNamesReader,
  ) {}

  template(): string {
    return templateCsv();
  }

  /**
   * Sede del lote (la de escritura del request); no disponible, 400. Se lee
   * ANTES que el fichero: sus errores se dicen en el formato de la sede.
   */
  private async batchLocation(): Promise<BatchLocation> {
    try {
      return await this.repo.batchLocation();
    } catch (err) {
      if (err instanceof BatchLocationError) {
        throw new BadRequestException(LOCATION_MESSAGE);
      }
      throw err;
    }
  }

  /** Cabeceras, mapeo sugerido y unas filas, sin escribir nada. */
  async inspect(file: UploadedFile | undefined): Promise<InspectResult> {
    const f = requireFile(file);
    const parsed = await readFile(f, await this.batchLocation());
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
    mapping: { columns: ColumnMapping | null; defaultDocType?: DocumentType },
    actorId: string,
  ): Promise<BatchDetail> {
    const f = requireFile(file);
    const location = await this.batchLocation();
    const parsed = await readFile(f, location);
    const input: MappingInput = {
      columns: mapping.columns ?? suggestMapping(parsed.table.headers),
      defaultDocType: mapping.defaultDocType,
    };
    let resolved;
    try {
      resolved = resolveMapping(parsed.table.headers, input);
    } catch (err) {
      throw fileErrorOf(err, location);
    }
    // DX-327 (R19): los nombres de la clínica, una vez por lote. Las filas
    // guardadas ya llevan el tipo: el worker no los necesita.
    const clinicNames = await this.documentTypeNames.get();
    const ctx = {
      defaultCallingCode: callingCodeOfCountry(location.country),
      today: civilDateIn(new Date(), location.timeZone),
      clinicNames,
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
      clinicNames,
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
      columnMapping: storedColumnMapping(columns, resolved.defaultDocType),
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
      balanceIssues: [],
      balanceIssuesTotal: 0,
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
    if (
      current.status === 'VALIDATED' &&
      current.preparedRows === 0 &&
      current.balancePreparedRows === 0
    ) {
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
    const imported = await this.repo.importedBalanceTotalsByBatch(
      items.filter((b) => b.balanceFileSha256 !== null).map((b) => b.id),
    );
    return {
      items: items.map((b) => this.toView(b, names, imported)),
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
      csv: issuesCsv(
        ((await this.repo.allIssues(id)) ?? []) as unknown as RowIssue[],
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Hoja de saldos «Saldo migrado» (DX-262)
  // -------------------------------------------------------------------------

  /** La fila de ejemplo lleva la moneda de la sede en contexto (nunca otra). */
  async balanceTemplate(): Promise<string> {
    const location = await this.batchLocation();
    if (!location.currency) throw locationCurrencyRequired(location.id);
    return balanceTemplateCsv(location.currency);
  }

  /**
   * Dry-run de la hoja de saldos de un lote VALIDATED (antes de confirmar):
   * valida cada fila, busca al paciente por su documento en la clínica y en
   * el archivo de pacientes del lote, suma las filas del mismo paciente y
   * moneda y guarda los saldos preparados con los totales por moneda. NO crea
   * ningún saldo migrado. Volver a subirla la reemplaza.
   *
   * Un paciente que ya tiene un saldo migrado vivo en esa moneda de otro
   * lote no recibe otro (QA D1: subir dos veces la misma hoja duplicaba la
   * deuda), salvo con `addToExisting` («Añadir aunque ya tenga saldo
   * migrado»).
   */
  async dryRunBalances(
    id: string,
    file: UploadedFile | undefined,
    addToExisting = false,
  ): Promise<BatchDetail> {
    const f = requireFile(file);
    const current = await this.repo.findBatch(id);
    if (!current) throw new NotFoundException(NOT_FOUND_MESSAGE);
    this.assertBalancesEditable(current);
    // La sede del lote, antes que el fichero: sus mensajes van en su formato.
    const location = await this.repo.locationFormatSettings(current.locationId);
    const parsed = await readFile(f, location);
    let cols;
    try {
      cols = resolveBalanceColumns(parsed.table.headers);
    } catch (err) {
      throw fileErrorOf(err, location);
    }
    const timeZone = await this.repo.locationTimeZone(current.locationId);
    const ctx = {
      today: civilDateIn(new Date(), timeZone),
      currencies: new Set(await this.repo.currencyCodes()),
      format: parsed.format,
    };

    const issues: RowIssue[] = [];
    const candidates: BalanceCandidate[] = [];
    const counted: { currency: string; cents: number }[] = [];
    let invalidRows = 0;
    let n = 0;
    for (const row of parsed.table.rows) {
      if (++n % YIELD_EVERY === 0) await yieldToEventLoop();
      const validated = validateBalanceRow(
        row,
        cols,
        ctx,
        parsed.table.headers,
      );
      if (validated.counted) counted.push(validated.counted);
      if (validated.candidate) candidates.push(validated.candidate);
      else {
        invalidRows += 1;
        issues.push(...validated.issues);
      }
    }
    const keys = [...new Set(candidates.map((c) => c.docKey))];
    const docs = await this.repo.knownDocs(id, keys);
    const existing = await this.repo.existingBalances(id, keys, timeZone);
    const aggregated = aggregateBalances(
      candidates,
      docs,
      cols.docNumber,
      () => requireLocationFormat(location),
      existing,
      addToExisting,
    );
    issues.push(...aggregated.issues);
    issues.sort((x, y) => x.row - y.row);

    let saved: BatchRow | null;
    try {
      saved = await this.repo.saveBalances(id, {
        fileName: safeFileName(f.originalname),
        fileSha256: sha256(f.buffer),
        fileFormat: parsed.format,
        fileSizeBytes: f.size,
        totalRows: parsed.table.rows.length,
        errorRows: invalidRows + aggregated.errorRows,
        mergedRows: aggregated.mergedRows,
        fileTotals: totalsByCurrency(counted),
        validTotals: aggregated.validTotals,
        issues,
        prepared: aggregated.prepared,
        addToExisting,
      });
    } catch (err) {
      if (err instanceof BatchStateError) {
        throw new ConflictException(BALANCES_NOT_EDITABLE_MESSAGE);
      }
      throw err;
    }
    if (!saved) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return {
      ...(await this.view(saved)),
      issues: [],
      issuesTotal: 0,
      preview: [],
      balanceIssues: issues.slice(0, MAX_ISSUES_IN_RESPONSE),
      balanceIssuesTotal: issues.length,
    };
  }

  /** Quita la hoja de saldos de un lote aún sin confirmar. */
  async removeBalances(id: string): Promise<BatchDetail> {
    const current = await this.repo.findBatch(id);
    if (!current) throw new NotFoundException(NOT_FOUND_MESSAGE);
    this.assertBalancesEditable(current);
    let cleared: BatchRow | null;
    try {
      cleared = await this.repo.clearBalances(id);
    } catch (err) {
      if (err instanceof BatchStateError) {
        throw new ConflictException(BALANCES_NOT_EDITABLE_MESSAGE);
      }
      throw err;
    }
    if (!cleared) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return this.detail(cleared);
  }

  async balanceErrorsCsv(
    id: string,
  ): Promise<{ fileName: string; csv: string }> {
    const batch = await this.repo.findBatch(id);
    if (!batch) throw new NotFoundException(NOT_FOUND_MESSAGE);
    if (
      batch.balanceFileName === null ||
      batch.issuesPurgedAt ||
      batch.status === 'EXPIRED'
    ) {
      throw new GoneException(BALANCE_REPORT_GONE_MESSAGE);
    }
    const base =
      batch.balanceFileName
        .replace(/\.[^.]*$/, '')
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 80) || 'saldos';
    return {
      fileName: `errores-${base}.csv`,
      csv: issuesCsv(
        ((await this.repo.allIssues(id, 'balances')) ??
          []) as unknown as RowIssue[],
      ),
    };
  }

  /** Solo un lote VALIDATED y vigente admite (o quita) su hoja de saldos. */
  private assertBalancesEditable(batch: BatchRow): void {
    if (batch.status !== 'VALIDATED') {
      throw new ConflictException(
        batch.status === 'EXPIRED'
          ? EXPIRED_MESSAGE
          : BALANCES_NOT_EDITABLE_MESSAGE,
      );
    }
    if (
      Date.now() >=
      batch.createdAt.getTime() + VALIDATION_TTL_HOURS * 3_600_000
    ) {
      throw new ConflictException(EXPIRED_MESSAGE);
    }
  }

  /**
   * Retira SOLO los saldos migrados del lote (DX-262, revisión C1), aunque
   * sus pacientes ya tengan actividad. 409 si alguno tiene abonos vivos.
   */
  async undoBalances(id: string, actorId: string): Promise<BatchDetail> {
    const current = await this.repo.findBatch(id);
    if (!current) throw new NotFoundException(NOT_FOUND_MESSAGE);
    try {
      await this.repo.undoBalances(id, actorId);
    } catch (err) {
      if (err instanceof UndoBlockedError) {
        throw new ConflictException(undoBlockedMessage(err));
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

  async undo(id: string, actorId: string): Promise<BatchDetail> {
    const current = await this.repo.findBatch(id);
    if (!current) throw new NotFoundException(NOT_FOUND_MESSAGE);
    try {
      await this.repo.undo(id, actorId);
    } catch (err) {
      if (err instanceof UndoBlockedError) {
        throw new ConflictException(
          undoBlockedMessage(err, current.balanceCreatedCount > 0),
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

  private async view(batch: BatchRow): Promise<BatchView> {
    const [names, imported] = await Promise.all([
      this.repo.userNames([batch.createdById]),
      batch.balanceFileSha256 === null
        ? Promise.resolve(new Map<string, ImportedBalanceTotal[]>())
        : this.repo.importedBalanceTotalsByBatch([batch.id]),
    ]);
    return this.toView(batch, names, imported);
  }

  private async detail(batch: BatchRow): Promise<BatchDetail> {
    // Solo los primeros errores, recortados en SQL: la pantalla consulta el
    // lote cada 1,5 s mientras importa (revisión 2026-10-23, menor 2).
    const [{ issues, total }, balanceIssues] = await Promise.all([
      this.repo.batchIssues(batch.id, MAX_ISSUES_IN_RESPONSE),
      batch.balanceFileSha256 === null
        ? Promise.resolve({ issues: [], total: 0 })
        : this.repo.batchIssues(batch.id, MAX_ISSUES_IN_RESPONSE, 'balances'),
    ]);
    return {
      ...(await this.view(batch)),
      issues: issues as unknown as RowIssue[],
      issuesTotal: total,
      preview: [],
      balanceIssues: balanceIssues.issues as unknown as RowIssue[],
      balanceIssuesTotal: balanceIssues.total,
    };
  }

  private balancesOf(
    batch: BatchRow,
    imported: Map<string, ImportedBalanceTotal[]>,
  ): BalancesView | null {
    if (
      batch.balanceFileName === null ||
      batch.balanceFileSha256 === null ||
      batch.balanceFileFormat === null ||
      batch.balanceFileSizeBytes === null
    ) {
      return null;
    }
    return {
      fileName: batch.balanceFileName,
      fileFormat: batch.balanceFileFormat,
      fileSizeBytes: batch.balanceFileSizeBytes,
      fileSha256: batch.balanceFileSha256,
      totalRows: batch.balanceTotalRows,
      validRows: batch.balanceTotalRows - batch.balanceErrorRows,
      errorRows: batch.balanceErrorRows,
      mergedRows: batch.balanceMergedRows,
      preparedCount: batch.balancePreparedRows,
      addToExisting: batch.balanceAddToExisting,
      fileTotals: toAmounts(batch.balanceFileTotals),
      validTotals: toAmounts(batch.balanceValidTotals),
      imported: (imported.get(batch.id) ?? []).map((t) => ({
        currency: t.currency,
        count: t.count,
        amount: fromCents(t.cents),
      })),
      progress: {
        processed: batch.balanceProcessedRows,
        created: batch.balanceCreatedCount,
        skipped: batch.balanceSkippedCount,
        ambiguous: batch.balanceAmbiguousCount,
        existing: batch.balanceExistingCount,
      },
      undoneCount: batch.balanceUndoneCount,
      undoneTotals: toAmounts(batch.balanceUndoneTotals),
      canUndo:
        (batch.status === 'COMPLETED' || batch.status === 'FAILED') &&
        (imported.get(batch.id) ?? []).length > 0,
    };
  }

  private toView(
    batch: BatchRow,
    names: Map<string, string>,
    imported: Map<string, ImportedBalanceTotal[]> = new Map(),
  ): BatchView {
    const toProcess = batch.preparedRows + batch.balancePreparedRows;
    const processed = batch.processedRows + batch.balanceProcessedRows;
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
        // Pacientes y, después, saldos migrados (DX-262).
        percent:
          toProcess === 0 ? 100 : Math.floor((processed / toProcess) * 100),
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
        toProcess > 0 &&
        Date.now() < validUntil,
      canUndo: batch.status === 'COMPLETED' || batch.status === 'FAILED',
      reportAvailable:
        batch.issuesPurgedAt === null && batch.status !== 'EXPIRED',
      balances: this.balancesOf(batch, imported),
    };
  }
}
