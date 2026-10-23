import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type ContactChannel,
  type PatientImportBatch,
  type PatientImportDuplicateMode,
  type PatientImportFileFormat,
  type PatientImportStatus,
  type Sex,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { lockPatientDocs } from '../../patients/infrastructure/patient-doc-lock';
import type { ExistingPatientDoc } from '../domain/dedupe';
import {
  fieldsToRevert,
  fillEmpty,
  type FilledValues,
  type FillablePatient,
} from '../domain/fill-empty';
import type { FillableField, ImportPatientData } from '../domain/import-fields';
import {
  DEFAULT_BALANCE_CONCEPT,
  totalsByCurrency,
  type CurrencyTotal,
  type DocLookup,
  type PreparedBalance,
} from '../domain/opening-balance-sheet';
import { docKey, type RowIssue } from '../domain/row-validation';

type Tx = Prisma.TransactionClient;

/** Interactiva larga: el dry-run inserta hasta 10.000 filas preparadas. */
const LONG_TX = { timeout: 120_000, maxWait: 10_000 } as const;
/** Un bloque de la importación: 250 filas con sus candados. */
const CHUNK_TX = { timeout: 60_000, maxWait: 10_000 } as const;
/** Filas por INSERT (Postgres admite 65.535 parámetros por sentencia). */
const INSERT_CHUNK = 2_000;
/** Pacientes por UPDATE al deshacer (cada sentencia refresca su cartera). */
const UNDO_CHUNK = 1_000;
/** Clave de idempotencia del trabajo de un lote (la usa también el barrido). */
export const importJobKey = (batchId: string) => `patient-import:${batchId}`;

/**
 * Tablas con FK a `patients` que NO cuentan como «actividad» del paciente al
 * deshacer un lote: las filas del propio lote (pacientes y saldos), el
 * resumen de cartera (lo mantiene la BD) y los saldos migrados, que se miran
 * aparte (DX-262): los del propio lote se retiran con él y uno de OTRO lote
 * bloquea. Cualquier otra tabla que apunte a un paciente lo bloquea.
 */
export const UNDO_IGNORED_TABLES: ReadonlySet<string> = new Set([
  'opening_balances',
  'patient_import_balance_rows',
  'patient_import_rows',
  'patient_ledgers',
]);

/** Saldos migrados por sentencia al importar (cada una refresca su cartera). */
const BALANCE_INSERT_CHUNK = 500;

/** Lo que el dry-run deja preparado: una fila por paciente a crear o a rellenar. */
export interface PreparedRow {
  rowNumber: number;
  data: ImportPatientData;
}

export interface NewBatch {
  createdById: string;
  locationId: string;
  fileName: string;
  fileSha256: string;
  fileFormat: PatientImportFileFormat;
  fileSizeBytes: number;
  columnMapping: Prisma.InputJsonObject;
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  errorRows: number;
  issues: RowIssue[];
  rows: PreparedRow[];
}

export interface ChunkResult {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

const EMPTY_RESULT: ChunkResult = {
  processed: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
};

/**
 * Pacientes del lote con algo registrado después, o saldos migrados del lote
 * con un abono imputado (DX-262): el deshacer se niega.
 */
export class UndoBlockedError extends Error {
  constructor(
    readonly patients: number,
    readonly balances = 0,
  ) {
    super('undo blocked');
  }
}

/**
 * El lote dejó de estar RUNNING mientras su trabajo seguía vivo (lo pasó a
 * FAILED `reapStuck` y quizá ya se deshizo): el bloque no escribe nada y el
 * trabajo termina sin reintentar.
 */
export class BatchNotRunningError extends Error {
  constructor(readonly status: PatientImportStatus | null) {
    super(`batch not running (${status ?? 'missing'})`);
    this.name = 'BatchNotRunningError';
  }
}

export class BatchStateError extends Error {
  constructor(readonly status: PatientImportStatus) {
    super(`batch in ${status}`);
  }
}

/** La sede del lote no existe o está inactiva. */
export class BatchLocationError extends Error {
  constructor() {
    super('batch location unavailable');
  }
}

export interface UndoResult {
  undoneCreated: number;
  undoneFilled: number;
  /** Saldos migrados del lote retirados (DX-262). */
  undoneBalances: number;
}

/** La hoja de saldos validada (dry-run) que se guarda en el lote (DX-262). */
export interface NewBalanceSheet {
  fileName: string;
  fileSha256: string;
  fileFormat: PatientImportFileFormat;
  fileSizeBytes: number;
  totalRows: number;
  errorRows: number;
  mergedRows: number;
  fileTotals: CurrencyTotal[];
  validTotals: CurrencyTotal[];
  issues: RowIssue[];
  prepared: PreparedBalance[];
}

export interface BalanceChunkResult {
  processed: number;
  created: number;
  /** Su paciente no existía al importar. */
  skipped: number;
  /** Su documento era de varios pacientes vivos (no se adivina). */
  ambiguous: number;
}

/** Saldos migrados vivos de un lote, por moneda (lo importado de verdad). */
export interface ImportedBalanceTotal {
  currency: string;
  count: number;
  cents: number;
}

/** Una columna que apunta a `opening_balances.id` (abonos, DX-262). */
export interface OpeningBalanceReference extends PatientReference {
  /** Columnas de retirada de esa tabla: la fila solo bloquea si están NULL. */
  live: string[];
}

/** Una columna que apunta a `patients.id` (de `pg_constraint`). */
export interface PatientReference {
  table: string;
  column: string;
}

export type ConfirmResult =
  { kind: 'confirmed'; batch: BatchRow } | { kind: 'expired' };

/**
 * Un lote SIN sus errores por fila (`issues`, hasta 10.000 y ~2 MB): lo que
 * leen el sondeo del avance y el historial. Los errores, con `batchIssues`
 * (los primeros) o `allIssues` (el informe).
 */
export type BatchRow = Omit<PatientImportBatch, 'issues' | 'balanceIssues'>;
const WITHOUT_ISSUES = { issues: true, balanceIssues: true } as const;

/**
 * ¿Es un fallo pasajero (BD caída, conexión cortada, interbloqueo, tiempo de
 * la transacción)? Entonces el bloque entero se reintenta más tarde (la
 * cola); si no, es un fallo de la fila y la fila queda FAILED.
 */
export function isTransientError(err: unknown): boolean {
  if (
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError
  ) {
    return true;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return [
      'P1001',
      'P1002',
      'P1008',
      'P1017',
      'P2024',
      'P2028',
      'P2034',
    ].includes(err.code);
  }
  const code = (err as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' &&
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      '57P01',
      '40001',
      '40P01',
    ].includes(code)
  );
}

/** Columnas que se rellenan, en el formato de Prisma. */
function patchOf(filled: FilledValues): Prisma.PatientUncheckedUpdateInput {
  const patch: Prisma.PatientUncheckedUpdateInput = {};
  for (const [field, value] of Object.entries(filled) as [
    FillableField,
    string,
  ][]) {
    if (field === 'birthDate')
      patch.birthDate = new Date(`${value}T00:00:00.000Z`);
    else if (field === 'sex') patch.sex = value as Sex;
    else patch[field] = value;
  }
  return patch;
}

/** Vuelve a dejar vacíos los campos que rellenó el lote. */
function revertPatch(
  fields: FillableField[],
): Prisma.PatientUncheckedUpdateInput {
  const patch: Prisma.PatientUncheckedUpdateInput = {};
  for (const field of fields) {
    if (field === 'sex') patch.sex = 'UNSPECIFIED';
    else patch[field] = null;
  }
  return patch;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Persistencia de la importación de pacientes (DX-107). Todo bajo
 * `runWithTenant` (RLS FORCE): el tenant sale del contexto, nunca del cliente.
 */
@Injectable()
export class PrismaPatientImportRepository {
  private references: Promise<PatientReference[]> | null = null;
  private balanceReferences: Promise<OpeningBalanceReference[]> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const id = this.tenantContext.getTenantId();
    if (!id) throw new Error('No tenant in context');
    return id;
  }

  /** Sede del lote (la de escritura del request), activa, y su país. */
  async batchLocation(): Promise<{ id: string; country: string }> {
    return this.prisma.runWithTenant(async (tx) => {
      const id = await this.tenantContext.writeLocationId(tx);
      const location = await tx.location.findFirst({
        where: { id, deletedAt: null, isActive: true },
        select: { id: true, country: true },
      });
      if (!location) throw new BatchLocationError();
      return location;
    });
  }

  /** Pacientes vivos de la clínica cuyo documento tiene alguna de esas claves. */
  async existingDocs(keys: string[]): Promise<ExistingPatientDoc[]> {
    if (keys.length === 0) return [];
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<ExistingPatientDoc[]>`
        SELECT "id", "docType",
               regexp_replace(upper("docNumber"), '[^0-9A-Z]', '', 'g') AS "docKey",
               ("partially_suppressed_at" IS NOT NULL) AS "partiallySuppressed"
          FROM "patients"
         WHERE "tenantId" = ${tenantId}::uuid
           AND "deletedAt" IS NULL
           AND "docNumber" IS NOT NULL
           AND regexp_replace(upper("docNumber"), '[^0-9A-Z]', '', 'g') = ANY(${keys}::text[])`,
    );
  }

  /**
   * Guarda el dry-run: el lote VALIDATED y sus filas preparadas. Los lotes
   * VALIDATED anteriores del mismo usuario caducan (se subió otro fichero).
   */
  async createBatch(input: NewBatch): Promise<PatientImportBatch> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      await this.expireValidated(tx, { createdById: input.createdById });
      const batch = await tx.patientImportBatch.create({
        data: {
          tenantId,
          createdById: input.createdById,
          locationId: input.locationId,
          fileName: input.fileName,
          fileSha256: input.fileSha256,
          fileFormat: input.fileFormat,
          fileSizeBytes: input.fileSizeBytes,
          columnMapping: input.columnMapping,
          totalRows: input.totalRows,
          validRows: input.validRows,
          duplicateRows: input.duplicateRows,
          errorRows: input.errorRows,
          preparedRows: input.rows.length,
          issues: input.issues as unknown as Prisma.InputJsonArray,
        },
      });
      for (let i = 0; i < input.rows.length; i += INSERT_CHUNK) {
        await tx.patientImportRow.createMany({
          data: input.rows.slice(i, i + INSERT_CHUNK).map((r) => ({
            tenantId,
            batchId: batch.id,
            rowNumber: r.rowNumber,
            data: r.data as unknown as Prisma.InputJsonObject,
          })),
        });
      }
      return batch;
    }, LONG_TX);
  }

  /**
   * VALIDATED → EXPIRED: se BORRAN sus filas preparadas (nunca crearon nada:
   * son datos del fichero que ya no hacen falta) y se vacían sus errores.
   * Los de un usuario al subir otro fichero, uno concreto o los anteriores a
   * `before` en el barrido diario.
   */
  private async expireValidated(
    tx: Tx,
    where: { createdById?: string; before?: Date; id?: string },
  ): Promise<number> {
    // PRIMERO se caducan (UPDATE … WHERE status = 'VALIDATED' RETURNING):
    // un lote que otra pestaña confirmó a la vez (QUEUED) no sale aquí y sus
    // filas preparadas no se borran (revisión 2026-10-23, menor 1).
    const expired = await tx.patientImportBatch.updateManyAndReturn({
      where: {
        status: 'VALIDATED',
        ...(where.id ? { id: where.id } : {}),
        ...(where.createdById ? { createdById: where.createdById } : {}),
        ...(where.before ? { createdAt: { lt: where.before } } : {}),
      },
      data: {
        status: 'EXPIRED',
        issues: [],
        balanceIssues: [],
        issuesPurgedAt: new Date(),
      },
      select: { id: true },
    });
    if (expired.length === 0) return 0;
    const ids = expired.map((b) => b.id);
    // Housekeeping de filas de un dry-run caducado (allowlist en
    // no-hard-delete.ts): no las referencia nada y no son datos de negocio.
    // eslint-disable-next-line no-restricted-syntax -- filas preparadas de un dry-run caducado
    await tx.patientImportRow.deleteMany({
      where: { batchId: { in: ids }, outcome: 'PENDING', patientId: null },
    });
    // DX-262: lo mismo con los saldos preparados de su hoja de saldos.
    // eslint-disable-next-line no-restricted-syntax -- saldos preparados de un dry-run caducado
    await tx.patientImportBalanceRow.deleteMany({
      where: { batchId: { in: ids }, outcome: 'PENDING' },
    });
    return ids.length;
  }

  /** Caduca UN lote (fuera de cualquier otra transacción). */
  async expireBatch(id: string): Promise<void> {
    await this.prisma.runWithTenant((tx) => this.expireValidated(tx, { id }));
  }

  /** Barrido diario: lotes sin confirmar de más de `before`, clínica a clínica. */
  async expireStale(tenantId: string, before: Date): Promise<number> {
    return this.prisma.runWithTenant(tenantId, (tx) =>
      this.expireValidated(tx, { before }),
    );
  }

  /**
   * Retención del informe (DX-107): los errores por fila (llevan valores del
   * fichero) de los lotes terminados o deshechos antes de `before` se vacían.
   */
  async purgeIssues(tenantId: string, before: Date): Promise<number> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const purged = await tx.patientImportBatch.updateManyAndReturn({
        where: {
          issuesPurgedAt: null,
          OR: [
            {
              status: { in: ['COMPLETED', 'FAILED'] },
              finishedAt: { lt: before },
            },
            { status: 'UNDONE', undoneAt: { lt: before } },
          ],
        },
        data: { issues: [], balanceIssues: [], issuesPurgedAt: new Date() },
        select: { id: true },
      });
      // DX-262 (revisión M3): los saldos preparados llevan el documento del
      // paciente y el importe del fichero; lo importado ya está en
      // opening_balances y el lote guarda hash y totales. Misma caducidad.
      if (purged.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- datos del fichero caducados (allowlist en no-hard-delete.ts)
        await tx.patientImportBalanceRow.deleteMany({
          where: { batchId: { in: purged.map((b) => b.id) } },
        });
      }
      return purged.length;
    });
  }

  /**
   * Lotes QUEUED/RUNNING cuyo trabajo ya no está vivo (agotó los intentos,
   * el arriendo venció sin reintentos o se purgó): pasan a FAILED con lo
   * hecho, para no dejar bloqueada la clínica (una importación en marcha) ni
   * el deshacer. `tenantId` explícito en el barrido; si no, el del contexto.
   */
  async reapStuck(tenantId?: string): Promise<number> {
    const run = async (tx: Tx) => {
      const reaped = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "patient_import_batches" b
           SET "status" = 'FAILED', "finishedAt" = now(), "updatedAt" = now()
         WHERE b."status" IN ('QUEUED', 'RUNNING')
           AND NOT EXISTS (
             SELECT 1 FROM "jobs" j
              WHERE j."tenantId" = b."tenantId"
                AND j."idempotencyKey" = 'patient-import:' || b."id"::text
                AND j."state" IN ('PENDING', 'RUNNING'))
        RETURNING b."id"`;
      if (reaped.length > 0) {
        await tx.patientImportRow.updateMany({
          where: {
            batchId: { in: reaped.map((r) => r.id) },
            outcome: 'PENDING',
          },
          data: { data: Prisma.DbNull },
        });
      }
      return reaped.length;
    };
    return tenantId
      ? this.prisma.runWithTenant(tenantId, run)
      : this.prisma.runWithTenant(run);
  }

  async tenantIds(): Promise<string[]> {
    const rows = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async findBatch(id: string): Promise<BatchRow | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.patientImportBatch.findFirst({ where: { id }, omit: WITHOUT_ISSUES }),
    );
  }

  /**
   * Los primeros `limit` errores del lote (o de su hoja de saldos, DX-262) y
   * cuántos hay, recortados en SQL.
   */
  async batchIssues(
    id: string,
    limit: number,
    sheet: 'patients' | 'balances' = 'patients',
  ): Promise<{ issues: Prisma.JsonValue[]; total: number }> {
    const column = Prisma.raw(
      sheet === 'balances' ? '"balanceIssues"' : '"issues"',
    );
    const rows = await this.prisma.runWithTenant(
      (tx) => tx.$queryRaw<{ issues: Prisma.JsonValue[]; total: number }[]>`
        SELECT jsonb_path_query_array(
                 ${column}, '$[0 to $last]',
                 jsonb_build_object('last', ${Math.max(0, limit - 1)}::int)) AS "issues",
               jsonb_array_length(${column})::int AS "total"
          FROM "patient_import_batches"
         WHERE "id" = ${id}::uuid`,
    );
    return rows[0] ?? { issues: [], total: 0 };
  }

  /** Todos los errores del lote o de su hoja de saldos (el informe). */
  async allIssues(
    id: string,
    sheet: 'patients' | 'balances' = 'patients',
  ): Promise<Prisma.JsonValue[] | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientImportBatch.findFirst({
        where: { id },
        select: { issues: true, balanceIssues: true },
      }),
    );
    if (!row) return null;
    return (
      sheet === 'balances' ? row.balanceIssues : row.issues
    ) as Prisma.JsonValue[];
  }

  // -------------------------------------------------------------------------
  // Hoja de saldos (DX-262)
  // -------------------------------------------------------------------------

  /**
   * Cómo está cada clave de documento: un paciente vivo de la clínica (o
   * una fila preparada del archivo de pacientes de ESTE lote, que creará o
   * encontrará al paciente) = FOUND; varios pacientes vivos con esa clave
   * (anteriores a DX-107: «1.111» y «1111») = AMBIGUOUS; ninguno, fuera.
   */
  async knownDocs(batchId: string, keys: string[]): Promise<DocLookup> {
    const out = new Map<string, 'FOUND' | 'AMBIGUOUS'>();
    if (keys.length === 0) return out;
    const tenantId = this.tenantId();
    // Por conjuntos (revisión I1): una pasada por patients y otra por las
    // filas del lote con `= ANY(keys)`, agrupadas por clave, como
    // `existingDocs`. Nunca una subconsulta por clave. Transacción larga:
    // una clínica grande y una hoja de 10.000 filas.
    const [patients, inFile] = await this.prisma.runWithTenant(
      (tx) =>
        Promise.all([
          tx.$queryRaw<{ docKey: string; n: number }[]>`
            SELECT regexp_replace(upper("docNumber"), '[^0-9A-Z]', '', 'g') AS "docKey",
                   count(*)::int AS "n"
              FROM "patients"
             WHERE "tenantId" = ${tenantId}::uuid
               AND "deletedAt" IS NULL
               AND "docNumber" IS NOT NULL
               AND regexp_replace(upper("docNumber"), '[^0-9A-Z]', '', 'g') = ANY(${keys}::text[])
             GROUP BY 1`,
          tx.$queryRaw<{ docKey: string }[]>`
            SELECT DISTINCT regexp_replace(upper("data"->>'docNumber'), '[^0-9A-Z]', '', 'g') AS "docKey"
              FROM "patient_import_rows"
             WHERE "tenantId" = ${tenantId}::uuid
               AND "batchId" = ${batchId}::uuid
               AND "outcome" = 'PENDING'
               AND "data" IS NOT NULL
               AND regexp_replace(upper("data"->>'docNumber'), '[^0-9A-Z]', '', 'g') = ANY(${keys}::text[])`,
        ]),
      LONG_TX,
    );
    for (const r of inFile) out.set(r.docKey, 'FOUND');
    for (const r of patients) {
      out.set(r.docKey, r.n > 1 ? 'AMBIGUOUS' : 'FOUND');
    }
    return out;
  }

  /**
   * Guarda (o reemplaza) la hoja de saldos de un lote VALIDATED: sus totales,
   * errores y los saldos preparados. `null` si el lote no es de la clínica;
   * `BatchStateError` si ya no está VALIDATED.
   */
  async saveBalances(
    batchId: string,
    input: NewBalanceSheet,
  ): Promise<BatchRow | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const status = await this.lockStatus(tx, batchId);
      if (status === null) return null;
      if (status !== 'VALIDATED') throw new BatchStateError(status);
      await this.deletePreparedBalances(tx, batchId);
      for (let i = 0; i < input.prepared.length; i += INSERT_CHUNK) {
        await tx.patientImportBalanceRow.createMany({
          data: input.prepared.slice(i, i + INSERT_CHUNK).map((b) => ({
            tenantId,
            batchId,
            rowNumber: b.rowNumber,
            docKey: b.docKey,
            currency: b.currency,
            amount: new Prisma.Decimal(b.cents).dividedBy(100),
            asOfDate: b.asOfDate
              ? new Date(`${b.asOfDate}T00:00:00.000Z`)
              : null,
            concept: b.concept,
            sourceRows: b.sourceRows,
          })),
        });
      }
      return tx.patientImportBatch.update({
        where: { id: batchId },
        omit: WITHOUT_ISSUES,
        data: {
          balanceFileName: input.fileName,
          balanceFileSha256: input.fileSha256,
          balanceFileFormat: input.fileFormat,
          balanceFileSizeBytes: input.fileSizeBytes,
          balanceTotalRows: input.totalRows,
          balanceErrorRows: input.errorRows,
          balanceMergedRows: input.mergedRows,
          balancePreparedRows: input.prepared.length,
          balanceFileTotals:
            input.fileTotals as unknown as Prisma.InputJsonArray,
          balanceValidTotals:
            input.validTotals as unknown as Prisma.InputJsonArray,
          balanceIssues: input.issues as unknown as Prisma.InputJsonArray,
        },
      });
    }, LONG_TX);
  }

  /** Quita la hoja de saldos de un lote VALIDATED (`null` si no es de la clínica). */
  async clearBalances(batchId: string): Promise<BatchRow | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const status = await this.lockStatus(tx, batchId);
      if (status === null) return null;
      if (status !== 'VALIDATED') throw new BatchStateError(status);
      await this.deletePreparedBalances(tx, batchId);
      return tx.patientImportBatch.update({
        where: { id: batchId },
        omit: WITHOUT_ISSUES,
        data: {
          balanceFileName: null,
          balanceFileSha256: null,
          balanceFileFormat: null,
          balanceFileSizeBytes: null,
          balanceTotalRows: 0,
          balanceErrorRows: 0,
          balanceMergedRows: 0,
          balancePreparedRows: 0,
          balanceFileTotals: [],
          balanceValidTotals: [],
          balanceIssues: [],
        },
      });
    });
  }

  private async lockStatus(
    tx: Tx,
    batchId: string,
  ): Promise<PatientImportStatus | null> {
    const rows = await tx.$queryRaw<{ status: PatientImportStatus }[]>`
      SELECT "status" FROM "patient_import_batches"
       WHERE "id" = ${batchId}::uuid FOR UPDATE`;
    return rows[0]?.status ?? null;
  }

  /** Saldos preparados de un dry-run que se reemplaza o se quita. */
  private async deletePreparedBalances(tx: Tx, batchId: string): Promise<void> {
    // Housekeeping (allowlist en no-hard-delete.ts): datos del fichero de un
    // dry-run sin confirmar; nada los referencia.
    // eslint-disable-next-line no-restricted-syntax -- saldos preparados de un dry-run reemplazado
    await tx.patientImportBalanceRow.deleteMany({
      where: { batchId, outcome: 'PENDING' },
    });
  }

  /**
   * Importa el siguiente bloque de saldos preparados del lote en SU
   * transacción corta (como los pacientes): busca al paciente vivo por la
   * clave del documento, crea su «Saldo migrado» (sin fecha en el archivo:
   * `today`, aproximada) y marca la fila. Idempotente: un saldo ya creado
   * no se repite (índice único por lote, paciente y moneda) y una fila ya
   * procesada no vuelve a salir. Un INSERT por bloque: el trigger del
   * resumen de cartera refresca solo a esos pacientes.
   */
  async processBalanceChunk(
    batch: Pick<PatientImportBatch, 'id' | 'confirmedById' | 'locationId'>,
    size: number,
    today: string,
  ): Promise<BalanceChunkResult> {
    const tenantId = this.tenantId();
    const chunk = Math.min(size, BALANCE_INSERT_CHUNK);
    return this.prisma.runWithTenant(async (tx) => {
      await this.assertRunning(tx, batch.id);
      const pending = await tx.$queryRaw<
        {
          id: string;
          docKey: string;
          currency: string;
          amount: Prisma.Decimal;
          asOfDate: Date | null;
          concept: string | null;
          sourceRows: number;
        }[]
      >`
        SELECT "id", "docKey", "currency", "amount", "asOfDate", "concept", "sourceRows"
          FROM "patient_import_balance_rows"
         WHERE "tenantId" = ${tenantId}::uuid AND "batchId" = ${batch.id}::uuid
           AND "outcome" = 'PENDING'
         ORDER BY "rowNumber", "currency"
         LIMIT ${chunk}
         FOR UPDATE SKIP LOCKED`;
      if (pending.length === 0) {
        return { processed: 0, created: 0, skipped: 0, ambiguous: 0 };
      }
      const keys = [...new Set(pending.map((r) => r.docKey))];
      // Solo una clave con UN paciente vivo: si hay varios, no se adivina
      // (ambiguo, se cuenta aparte: revisión M7).
      const patients = await tx.$queryRaw<
        { id: string; docKey: string; n: number }[]
      >`
        SELECT min(p."id"::text)::uuid AS "id", k."docKey", count(*)::int AS "n"
          FROM "patients" p
          JOIN unnest(${keys}::text[]) AS k("docKey")
            ON regexp_replace(upper(p."docNumber"), '[^0-9A-Z]', '', 'g') = k."docKey"
         WHERE p."tenantId" = ${tenantId}::uuid AND p."deletedAt" IS NULL
           AND p."docNumber" IS NOT NULL
         GROUP BY k."docKey"`;
      const patientOf = new Map(
        patients.filter((p) => p.n === 1).map((p) => [p.docKey, p.id]),
      );
      const ambiguousKeys = new Set(
        patients.filter((p) => p.n > 1).map((p) => p.docKey),
      );
      const createdById = batch.confirmedById as string;
      const toCreate = pending.filter((r) => patientOf.has(r.docKey));
      if (toCreate.length > 0) {
        await tx.openingBalance.createMany({
          skipDuplicates: true,
          data: toCreate.map((r) => ({
            tenantId,
            locationId: batch.locationId,
            patientId: patientOf.get(r.docKey) as string,
            importBatchId: batch.id,
            currency: r.currency,
            amount: r.amount,
            asOfDate: r.asOfDate ?? new Date(`${today}T00:00:00.000Z`),
            asOfDateApproximate: r.asOfDate === null,
            concept: r.concept ?? DEFAULT_BALANCE_CONCEPT,
            sourceRows: r.sourceRows,
            createdById,
          })),
        });
      }
      const ids = pending.map((r) => r.id);
      const outcomes = pending.map((r) =>
        patientOf.has(r.docKey)
          ? 'CREATED'
          : ambiguousKeys.has(r.docKey)
            ? 'FAILED'
            : 'SKIPPED',
      );
      const patientIds = pending.map((r) => patientOf.get(r.docKey) ?? null);
      await tx.$executeRaw`
        UPDATE "patient_import_balance_rows" r
           SET "outcome" = v.outcome::"PatientImportRowOutcome",
               "patientId" = v.patient_id,
               "processedAt" = timezone('UTC', now())
          FROM (SELECT unnest(${ids}::uuid[]) AS id,
                       unnest(${outcomes}::text[]) AS outcome,
                       unnest(${patientIds}::uuid[]) AS patient_id) v
         WHERE r."id" = v.id`;
      const ambiguous = outcomes.filter((o) => o === 'FAILED').length;
      const result = {
        processed: pending.length,
        created: toCreate.length,
        skipped: pending.length - toCreate.length - ambiguous,
        ambiguous,
      };
      await tx.patientImportBatch.update({
        where: { id: batch.id },
        data: {
          balanceProcessedRows: { increment: result.processed },
          balanceCreatedCount: { increment: result.created },
          balanceSkippedCount: { increment: result.skipped },
          balanceAmbiguousCount: { increment: result.ambiguous },
        },
      });
      return result;
    }, CHUNK_TX);
  }

  /** Saldos migrados VIVOS del lote por moneda: lo que de verdad se importó. */
  async importedBalanceTotals(
    batchId: string,
  ): Promise<ImportedBalanceTotal[]> {
    return (
      (await this.importedBalanceTotalsByBatch([batchId])).get(batchId) ?? []
    );
  }

  /** Lo mismo para varios lotes (el historial), en UNA consulta. */
  async importedBalanceTotalsByBatch(
    batchIds: string[],
  ): Promise<Map<string, ImportedBalanceTotal[]>> {
    const out = new Map<string, ImportedBalanceTotal[]>();
    if (batchIds.length === 0) return out;
    const tenantId = this.tenantId();
    const rows = await this.prisma.runWithTenant(
      (tx) => tx.$queryRaw<(ImportedBalanceTotal & { batchId: string })[]>`
        SELECT "importBatchId" AS "batchId", "currency", count(*)::int AS "count",
               (sum("amount") * 100)::bigint::float8 AS "cents"
          FROM "opening_balances"
         WHERE "tenantId" = ${tenantId}::uuid
           AND "importBatchId" = ANY(${batchIds}::uuid[])
           AND "voidedAt" IS NULL
         GROUP BY "importBatchId", "currency"
         ORDER BY "importBatchId", "currency"`,
    );
    for (const { batchId, ...total } of rows) {
      const list = out.get(batchId) ?? [];
      list.push(total);
      out.set(batchId, list);
    }
    return out;
  }

  /**
   * Monedas admitidas: el catálogo `currencies` (global, sin RLS), el mismo
   * que valida planes y abonos (DX-042).
   */
  async currencyCodes(): Promise<string[]> {
    const rows = await this.prisma.currency.findMany({
      select: { code: true },
      orderBy: { code: 'asc' },
    });
    return rows.map((r) => r.code);
  }

  /** País de la sede del lote (su zona decide el «hoy» de los saldos sin fecha). */
  async locationCountry(locationId: string): Promise<string> {
    return this.prisma.runWithTenant(async (tx) => {
      const location = await tx.location.findFirstOrThrow({
        where: { id: locationId },
        select: { country: true },
      });
      return location.country;
    });
  }

  async listBatches(
    take: number,
    skip: number,
  ): Promise<{ items: BatchRow[]; total: number }> {
    return this.prisma.runWithTenant(async (tx) => {
      const where = {
        status: { notIn: ['VALIDATED', 'EXPIRED'] as PatientImportStatus[] },
      };
      const [items, total] = await Promise.all([
        tx.patientImportBatch.findMany({
          where,
          omit: WITHOUT_ISSUES,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          skip,
        }),
        tx.patientImportBatch.count({ where }),
      ]);
      return { items, total };
    });
  }

  /** Nombres de los usuarios (tabla global `users`, sin RLS). */
  async userNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  /**
   * Confirma un lote VALIDATED: pasa a QUEUED con el modo elegido y encola
   * el trabajo en la MISMA transacción (outbox). Un lote caducado NO se toca
   * aquí (la transacción se desharía con el error): se devuelve `expired` y
   * quien llama lo caduca en la suya.
   */
  async confirm(
    id: string,
    input: {
      mode: PatientImportDuplicateMode;
      confirmedById: string;
      validatedAfter: Date;
      enqueue: (tx: Tx) => Promise<void>;
    },
  ): Promise<ConfirmResult | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await tx.$queryRaw<
        { status: PatientImportStatus; createdAt: Date }[]
      >`
        SELECT "status", "createdAt" FROM "patient_import_batches"
         WHERE "id" = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) return null;
      const { status, createdAt } = locked[0];
      if (status === 'VALIDATED' && createdAt < input.validatedAfter) {
        return { kind: 'expired' as const };
      }
      if (status !== 'VALIDATED') throw new BatchStateError(status);
      const batch = await tx.patientImportBatch.update({
        where: { id },
        omit: WITHOUT_ISSUES,
        data: {
          status: 'QUEUED',
          duplicateMode: input.mode,
          confirmedById: input.confirmedById,
          confirmedAt: new Date(),
        },
      });
      await input.enqueue(tx);
      return { kind: 'confirmed' as const, batch };
    });
  }

  /** ¿Hay otro lote de la clínica en cola o en curso? */
  async activeBatchId(): Promise<string | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const active = await tx.patientImportBatch.findFirst({
        where: { status: { in: ['QUEUED', 'RUNNING'] } },
        select: { id: true },
      });
      return active?.id ?? null;
    });
  }

  /** QUEUED → RUNNING. Devuelve el lote si hay trabajo que hacer. */
  async start(id: string): Promise<BatchRow | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<{ status: PatientImportStatus }[]>`
        SELECT "status" FROM "patient_import_batches" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const status = rows[0]?.status;
      if (status !== 'QUEUED' && status !== 'RUNNING') return null;
      return tx.patientImportBatch.update({
        where: { id },
        omit: WITHOUT_ISSUES,
        data:
          status === 'QUEUED'
            ? { status: 'RUNNING', startedAt: new Date() }
            : {},
      });
    });
  }

  async clinicDefaultChannel(): Promise<ContactChannel> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: { defaultContactChannel: true },
    });
    return tenant.defaultContactChannel;
  }

  /**
   * Procesa el siguiente bloque de filas PENDING del lote en SU transacción
   * (nunca una transacción por todo el fichero: cada bloque bloquea solo sus
   * filas y libera al confirmar). Idempotente: una fila ya procesada no
   * vuelve a salir. Un fallo PASAJERO (BD, conexión, interbloqueo) sube y lo
   * reintenta la cola; cualquier otro se reintenta fila a fila y la fila que
   * siga fallando queda FAILED: el resto del lote sigue.
   */
  async processChunk(
    batch: Pick<PatientImportBatch, 'id' | 'duplicateMode' | 'confirmedById'>,
    size: number,
    channel: ContactChannel,
  ): Promise<ChunkResult> {
    const pending = await this.prisma.runWithTenant((tx) =>
      tx.patientImportRow.findMany({
        where: { batchId: batch.id, outcome: 'PENDING' },
        orderBy: { rowNumber: 'asc' },
        take: size,
        select: { id: true, rowNumber: true, data: true },
      }),
    );
    if (pending.length === 0) return { ...EMPTY_RESULT };
    try {
      return await this.prisma.runWithTenant(
        (tx) => this.applyRows(tx, batch, pending, channel),
        CHUNK_TX,
      );
    } catch (chunkError) {
      if (
        isTransientError(chunkError) ||
        chunkError instanceof BatchNotRunningError
      ) {
        throw chunkError;
      }
      const total: ChunkResult = { ...EMPTY_RESULT };
      for (const row of pending) {
        let one: ChunkResult;
        try {
          one = await this.prisma.runWithTenant(
            (tx) => this.applyRows(tx, batch, [row], channel),
            CHUNK_TX,
          );
        } catch (rowError) {
          if (
            isTransientError(rowError) ||
            rowError instanceof BatchNotRunningError
          ) {
            throw rowError;
          }
          one = await this.failRow(batch.id, row.id);
        }
        total.processed += one.processed;
        total.created += one.created;
        total.updated += one.updated;
        total.skipped += one.skipped;
        total.failed += one.failed;
      }
      return total;
    }
  }

  /**
   * Al empezar CADA transacción que escribe del bloque: el lote sigue
   * RUNNING, bajo `FOR SHARE` hasta el COMMIT. El deshacer toma el lote
   * `FOR UPDATE`, así que los dos se serializan: un bloque en vuelo espera a
   * que el deshacer confirme y entonces ve UNDONE, o el deshacer espera al
   * bloque y ve sus pacientes (revisión 2026-10-23, I4).
   */
  private async assertRunning(tx: Tx, batchId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ status: PatientImportStatus }[]>`
      SELECT "status" FROM "patient_import_batches"
       WHERE "id" = ${batchId}::uuid FOR SHARE`;
    const status = rows[0]?.status ?? null;
    if (status !== 'RUNNING') throw new BatchNotRunningError(status);
  }

  /** La fila no se pudo importar por un error suyo: FAILED y se sigue. */
  private async failRow(batchId: string, rowId: string): Promise<ChunkResult> {
    return this.prisma.runWithTenant(async (tx) => {
      await this.assertRunning(tx, batchId);
      const n = await tx.patientImportRow.updateMany({
        where: { id: rowId, outcome: 'PENDING' },
        data: {
          outcome: 'FAILED',
          data: Prisma.DbNull,
          processedAt: new Date(),
        },
      });
      const result = { ...EMPTY_RESULT, processed: n.count, failed: n.count };
      await this.bumpCounters(tx, batchId, result);
      return result;
    });
  }

  private async applyRows(
    tx: Tx,
    batch: Pick<PatientImportBatch, 'id' | 'duplicateMode' | 'confirmedById'>,
    rows: { id: string; rowNumber: number; data: Prisma.JsonValue }[],
    channel: ContactChannel,
  ): Promise<ChunkResult> {
    const tenantId = this.tenantId();
    await this.assertRunning(tx, batch.id);
    const items = rows
      .filter((r) => r.data !== null)
      .map((r) => ({ ...r, data: r.data as unknown as ImportPatientData }));
    // Candado por documento normalizado (el mismo del alta manual): un alta
    // a la vez con «1.111.111» y la importación con «1111111» se serializan.
    await lockPatientDocs(
      tx,
      tenantId,
      items.map((i) => i.data.docNumber),
    );
    const keys = [...new Set(items.map((r) => docKey(r.data.docNumber)))];
    // Los pacientes que YA existen, bloqueados: rellenar sus vacíos no
    // compite con una edición a la vez.
    const existing = keys.length
      ? await tx.$queryRaw<
          (FillablePatient & { id: string; docType: string; docKey: string })[]
        >`
          SELECT "id", "docType", "birthDate", "sex", "phone", "email", "address",
                 "occupation", "emergencyContactName", "emergencyContactPhone", "notes",
                 "partially_suppressed_at" AS "partiallySuppressedAt",
                 regexp_replace(upper("docNumber"), '[^0-9A-Z]', '', 'g') AS "docKey"
            FROM "patients"
           WHERE "tenantId" = ${tenantId}::uuid AND "deletedAt" IS NULL AND "docNumber" IS NOT NULL
             AND regexp_replace(upper("docNumber"), '[^0-9A-Z]', '', 'g') = ANY(${keys}::text[])
           ORDER BY "id"
           FOR UPDATE`
      : [];
    const byKey = new Map(existing.map((p) => [p.docKey, p]));
    const outcomes: {
      id: string;
      outcome: string;
      patientId: string | null;
      filled: string | null;
    }[] = [];
    const fresh: typeof items = [];

    for (const item of items) {
      const match = byKey.get(docKey(item.data.docNumber));
      if (!match) {
        fresh.push(item);
        continue;
      }
      // Otro tipo con el mismo número (creado tras el dry-run): no se toca.
      const sameType = match.docType === item.data.docType;
      if (!sameType || batch.duplicateMode !== 'FILL_EMPTY') {
        outcomes.push({
          id: item.id,
          outcome: 'SKIPPED',
          patientId: sameType ? match.id : null,
          filled: null,
        });
        continue;
      }
      const filled = fillEmpty(match, item.data);
      if (Object.keys(filled).length === 0) {
        outcomes.push({
          id: item.id,
          outcome: 'SKIPPED',
          patientId: match.id,
          filled: null,
        });
        continue;
      }
      await tx.patient.update({
        where: { id: match.id },
        data: patchOf(filled),
      });
      outcomes.push({
        id: item.id,
        outcome: 'FILLED',
        patientId: match.id,
        filled: JSON.stringify(filled),
      });
    }

    if (fresh.length > 0) {
      const now = new Date();
      // ON CONFLICT DO NOTHING (patients_tenant_doc_key): dos filas del mismo
      // documento en el bloque (no debería: el dry-run las quita) crean uno.
      const created = await tx.patient.createManyAndReturn({
        skipDuplicates: true,
        select: { id: true, docNumber: true },
        data: fresh.map((r) => ({
          tenantId,
          importBatchId: batch.id,
          contactChannel: channel,
          createdById: batch.confirmedById,
          firstName: r.data.firstName,
          lastName: r.data.lastName,
          docType: r.data.docType,
          docNumber: r.data.docNumber,
          birthDate: r.data.birthDate
            ? new Date(`${r.data.birthDate}T00:00:00.000Z`)
            : null,
          sex: r.data.sex ?? 'UNSPECIFIED',
          phone: r.data.phone ?? null,
          email: r.data.email ?? null,
          address: r.data.address ?? null,
          occupation: r.data.occupation ?? null,
          emergencyContactName: r.data.emergencyContactName ?? null,
          emergencyContactPhone: r.data.emergencyContactPhone ?? null,
          notes: r.data.notes ?? null,
          createdAt: now,
          updatedAt: now,
        })),
      });
      const idByDoc = new Map(created.map((p) => [p.docNumber, p.id]));
      const used = new Set<string>();
      for (const r of fresh) {
        const patientId = idByDoc.get(r.data.docNumber);
        if (patientId && !used.has(patientId)) {
          used.add(patientId);
          outcomes.push({
            id: r.id,
            outcome: 'CREATED',
            patientId,
            filled: null,
          });
        } else {
          outcomes.push({
            id: r.id,
            outcome: 'SKIPPED',
            patientId: null,
            filled: null,
          });
        }
      }
    }
    // Filas sin datos (no debería haber: se vacían al procesarlas).
    for (const r of rows.filter((x) => x.data === null)) {
      outcomes.push({
        id: r.id,
        outcome: 'SKIPPED',
        patientId: null,
        filled: null,
      });
    }

    // Solo cuenta lo que de verdad pasó de PENDING a su resultado.
    const done = await tx.$queryRaw<{ outcome: string }[]>`
      UPDATE "patient_import_rows" r
         SET "outcome" = v.outcome::"PatientImportRowOutcome",
             "patientId" = v.patient_id,
             "filledValues" = v.filled::jsonb,
             "data" = NULL,
             "processedAt" = now()
        FROM (SELECT unnest(${outcomes.map((o) => o.id)}::uuid[]) AS id,
                     unnest(${outcomes.map((o) => o.outcome)}::text[]) AS outcome,
                     unnest(${outcomes.map((o) => o.patientId)}::uuid[]) AS patient_id,
                     unnest(${outcomes.map((o) => o.filled)}::text[]) AS filled) v
       WHERE r."id" = v.id AND r."outcome" = 'PENDING'
      RETURNING v.outcome`;
    const count = (o: string) => done.filter((d) => d.outcome === o).length;
    const result: ChunkResult = {
      processed: done.length,
      created: count('CREATED'),
      updated: count('FILLED'),
      skipped: count('SKIPPED'),
      failed: 0,
    };
    await this.bumpCounters(tx, batch.id, result);
    return result;
  }

  private async bumpCounters(
    tx: Tx,
    batchId: string,
    r: ChunkResult,
  ): Promise<void> {
    if (r.processed === 0) return;
    await tx.patientImportBatch.update({
      where: { id: batchId },
      data: {
        processedRows: { increment: r.processed },
        createdCount: { increment: r.created },
        updatedCount: { increment: r.updated },
        skippedCount: { increment: r.skipped },
        failedCount: { increment: r.failed },
      },
    });
  }

  async finish(id: string, status: 'COMPLETED' | 'FAILED'): Promise<void> {
    await this.prisma.runWithTenant(async (tx) => {
      if (status === 'FAILED') {
        // Lo que quedó sin procesar ya no se importará: fuera sus datos.
        await tx.patientImportRow.updateMany({
          where: { batchId: id, outcome: 'PENDING' },
          data: { data: Prisma.DbNull },
        });
      }
      await tx.patientImportBatch.updateMany({
        where: { id, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status, finishedAt: new Date() },
      });
    });
  }

  /**
   * Columnas que apuntan a `patients.id`, leídas del catálogo (`pg_constraint`)
   * una vez por proceso: una tabla nueva con FK a pacientes bloquea el
   * deshacer sin tocar este código. Excluye `UNDO_IGNORED_TABLES`.
   */
  patientReferences(): Promise<PatientReference[]> {
    this.references ??= this.prisma.$queryRaw<PatientReference[]>`
      SELECT cl.relname AS "table", a.attname AS "column"
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
        CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(con, conf)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.con
        JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.conf
       WHERE c.contype = 'f'
         AND c.confrelid = 'public.patients'::regclass
         AND fa.attname = 'id'
       ORDER BY 1, 2`.then((rows) =>
      rows.filter((r) => !UNDO_IGNORED_TABLES.has(r.table)),
    );
    return this.references;
  }

  /**
   * Columnas que apuntan a `opening_balances.id` (DX-262), del catálogo, una
   * vez por proceso: hoy `payments.openingBalanceId` (abonos contra el saldo
   * migrado). Una tabla nueva que se le cuelgue bloqueará el deshacer sin
   * tocar este código. `live`: las columnas de retirada que tiene esa tabla
   * (`deletedAt`, `voidedAt`): una fila anulada no bloquea (revisión M4).
   */
  openingBalanceReferences(): Promise<OpeningBalanceReference[]> {
    this.balanceReferences ??= this.prisma.$queryRaw<OpeningBalanceReference[]>`
      SELECT cl.relname AS "table", a.attname AS "column",
             ARRAY(SELECT la.attname::text FROM pg_attribute la
                    WHERE la.attrelid = cl.oid AND NOT la.attisdropped
                      AND la.attname IN ('deletedAt', 'voidedAt')
                    ORDER BY 1) AS "live"
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
        CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(con, conf)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.con
        JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.conf
       WHERE c.contype = 'f'
         AND c.confrelid = 'public.opening_balances'::regclass
         AND fa.attname = 'id'
       ORDER BY 1, 2`;
    return this.balanceReferences;
  }

  /**
   * Los saldos migrados vivos del lote, bloqueados FOR UPDATE (un abono que
   * llega a la vez espera y después ve el saldo retirado: 404). Se niega
   * (`UndoBlockedError` con `balances`) si alguno tiene abonos VIVOS.
   */
  private async lockUndoableBalances(
    tx: Tx,
    batchId: string,
    references: OpeningBalanceReference[],
  ): Promise<{ id: string; currency: string; cents: number }[]> {
    const tenantId = this.tenantId();
    const balances = await tx.$queryRaw<
      { id: string; currency: string; cents: number }[]
    >`
      SELECT "id", "currency", ("amount" * 100)::bigint::float8 AS "cents"
        FROM "opening_balances"
       WHERE "tenantId" = ${tenantId}::uuid AND "importBatchId" = ${batchId}::uuid
         AND "voidedAt" IS NULL
       ORDER BY "id"
       FOR UPDATE`;
    const ids = balances.map((b) => b.id);
    if (ids.length > 0 && references.length > 0) {
      const checks = references.map((ref) => {
        const live = ref.live.map(
          (col) => Prisma.sql`AND ${Prisma.raw(quoteIdent(col))} IS NULL`,
        );
        return Prisma.sql`SELECT ${Prisma.raw(quoteIdent(ref.column))}::uuid AS id
                            FROM ${Prisma.raw(quoteIdent(ref.table))}
                           WHERE ${Prisma.raw(quoteIdent(ref.column))} = ANY(${ids}::uuid[])
                           ${Prisma.join(live, ' ', '', '')}`;
      });
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(DISTINCT id)::int AS n FROM (${Prisma.join(checks, ' UNION ALL ')}) a`;
      if (n > 0) throw new UndoBlockedError(0, n);
    }
    return balances;
  }

  /**
   * Retira (en blando, hora UTC de la BD) esos saldos del lote, antes que
   * los pacientes (el refresco de cartera de cada sentencia ya los ve fuera),
   * por sentencias de 1.000, y suma lo retirado al lote (cuántos y cuánto por
   * moneda: la auditoría dice lo que se hizo, revisión M5).
   */
  private async retireBalances(
    tx: Tx,
    batchId: string,
    undoneById: string,
    balances: { id: string; currency: string; cents: number }[],
  ): Promise<void> {
    if (balances.length === 0) return;
    const tenantId = this.tenantId();
    const ids = balances.map((b) => b.id);
    for (let i = 0; i < ids.length; i += UNDO_CHUNK) {
      await tx.$executeRaw`
        UPDATE "opening_balances"
           SET "voidedAt" = timezone('UTC', now()), "voidedById" = ${undoneById}::uuid
         WHERE "tenantId" = ${tenantId}::uuid
           AND "id" = ANY(${ids.slice(i, i + UNDO_CHUNK)}::uuid[])`;
    }
    const before = await tx.patientImportBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { balanceUndoneCount: true, balanceUndoneTotals: true },
    });
    await tx.patientImportBatch.update({
      where: { id: batchId },
      data: {
        balanceUndoneCount: (before.balanceUndoneCount ?? 0) + balances.length,
        balanceUndoneTotals: totalsByCurrency([
          ...((before.balanceUndoneTotals ?? []) as unknown as CurrencyTotal[]),
          ...balances.map((b) => ({ currency: b.currency, cents: b.cents })),
        ]) as unknown as Prisma.InputJsonArray,
      },
    });
  }

  /**
   * Deshacer SOLO los saldos migrados del lote (DX-262, revisión C1), aunque
   * sus pacientes ya tengan citas o historia: el lote sigue importado. Se
   * niega si algún saldo tiene abonos vivos.
   */
  async undoBalances(
    id: string,
    undoneById: string,
  ): Promise<{ undoneBalances: number }> {
    const references = await this.openingBalanceReferences();
    return this.prisma.runWithTenant(async (tx) => {
      const status = await this.lockStatus(tx, id);
      if (status === null) throw new BatchStateError('EXPIRED');
      if (status !== 'COMPLETED' && status !== 'FAILED')
        throw new BatchStateError(status);
      const balances = await this.lockUndoableBalances(tx, id, references);
      await this.retireBalances(tx, id, undoneById, balances);
      return { undoneBalances: balances.length };
    }, LONG_TX);
  }

  /**
   * «Deshacer lote»: retira en blando los pacientes que CREÓ el lote y
   * revierte lo que rellenó en los existentes (solo los campos que siguen con
   * el valor del lote). Se niega si alguno de los creados aparece en
   * CUALQUIER tabla que apunte a pacientes (citas, historia, planes, pagos,
   * documentos, consentimientos…). Una transacción que bloquea solo las
   * filas del lote.
   */
  async undo(id: string, undoneById: string): Promise<UndoResult> {
    const tenantId = this.tenantId();
    const references = await this.patientReferences();
    const balanceReferences = await this.openingBalanceReferences();
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await tx.$queryRaw<{ status: PatientImportStatus }[]>`
        SELECT "status" FROM "patient_import_batches" WHERE "id" = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new BatchStateError('EXPIRED');
      const { status } = locked[0];
      if (status !== 'COMPLETED' && status !== 'FAILED')
        throw new BatchStateError(status);

      // DX-262: primero los saldos (un abono vivo lo niega con su motivo).
      const balances = await this.lockUndoableBalances(
        tx,
        id,
        balanceReferences,
      );

      const created = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "patients"
         WHERE "tenantId" = ${tenantId}::uuid AND "import_batch_id" = ${id}::uuid
           AND "deletedAt" IS NULL
         ORDER BY "id"
         FOR UPDATE`;
      const ids = created.map((p) => p.id);
      if (ids.length > 0) {
        const checks = references.map(
          (ref) =>
            Prisma.sql`SELECT ${Prisma.raw(quoteIdent(ref.column))}::uuid AS id
                         FROM ${Prisma.raw(quoteIdent(ref.table))}
                        WHERE ${Prisma.raw(quoteIdent(ref.column))} = ANY(${ids}::uuid[])`,
        );
        // DX-262: un saldo migrado de OTRO lote también es actividad (los
        // del propio lote se retiran con él).
        checks.push(Prisma.sql`SELECT "patientId" AS id FROM "opening_balances"
                                WHERE "tenantId" = ${tenantId}::uuid
                                  AND "patientId" = ANY(${ids}::uuid[])
                                  AND "importBatchId" <> ${id}::uuid
                                  AND "voidedAt" IS NULL`);
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(DISTINCT id)::int AS n FROM (${Prisma.join(checks, ' UNION ALL ')}) a`;
        if (n > 0) throw new UndoBlockedError(n);
      }

      await this.retireBalances(tx, id, undoneById, balances);
      for (let i = 0; i < ids.length; i += UNDO_CHUNK) {
        await tx.$executeRaw`
          UPDATE "patients"
             SET "deletedAt" = timezone('UTC', now()), "updatedAt" = timezone('UTC', now())
           WHERE "tenantId" = ${tenantId}::uuid AND "id" = ANY(${ids.slice(i, i + UNDO_CHUNK)}::uuid[])`;
      }

      const filledRows = await tx.patientImportRow.findMany({
        where: { batchId: id, outcome: 'FILLED' },
        select: { patientId: true, filledValues: true },
      });
      let undoneFilled = 0;
      for (let i = 0; i < filledRows.length; i += UNDO_CHUNK) {
        const slice = filledRows.slice(i, i + UNDO_CHUNK);
        const patientIds = slice.map((r) => r.patientId as string);
        const patients = await tx.$queryRaw<
          (FillablePatient & { id: string })[]
        >`
          SELECT "id", "birthDate", "sex", "phone", "email", "address", "occupation",
                 "emergencyContactName", "emergencyContactPhone", "notes"
            FROM "patients"
           WHERE "tenantId" = ${tenantId}::uuid AND "id" = ANY(${patientIds}::uuid[])
             AND "deletedAt" IS NULL
           ORDER BY "id"
           FOR UPDATE`;
        const byId = new Map(patients.map((p) => [p.id, p]));
        for (const row of slice) {
          const patient = byId.get(row.patientId as string);
          if (!patient) continue;
          const fields = fieldsToRevert(
            patient,
            row.filledValues as FilledValues,
          );
          if (fields.length === 0) continue;
          await tx.patient.update({
            where: { id: patient.id },
            data: revertPatch(fields),
          });
          undoneFilled += 1;
        }
      }

      await tx.patientImportBatch.update({
        where: { id },
        data: {
          status: 'UNDONE',
          undoneAt: new Date(),
          undoneById,
          undoneCreated: ids.length,
          undoneFilled,
        },
      });
      return {
        undoneCreated: ids.length,
        undoneFilled,
        undoneBalances: balances.length,
      };
    }, LONG_TX);
  }
}
