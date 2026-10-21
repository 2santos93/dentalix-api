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
import type { ExistingPatientDoc } from '../domain/dedupe';
import {
  fieldsToRevert,
  fillEmpty,
  type FilledValues,
  type FillablePatient,
} from '../domain/fill-empty';
import type { FillableField, ImportPatientData } from '../domain/import-fields';
import { docKey, type RowIssue } from '../domain/row-validation';

type Tx = Prisma.TransactionClient;

/** Interactiva larga: el dry-run inserta hasta 10.000 filas preparadas. */
const LONG_TX = { timeout: 120_000, maxWait: 10_000 } as const;
/** Filas por INSERT (Postgres admite 65.535 parámetros por sentencia). */
const INSERT_CHUNK = 2_000;
/** Pacientes por UPDATE al deshacer (cada sentencia refresca su cartera). */
const UNDO_CHUNK = 1_000;

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

/** Pacientes del lote con algo registrado después: el deshacer se niega. */
export class UndoBlockedError extends Error {
  constructor(readonly patients: number) {
    super('undo blocked');
  }
}

export class BatchStateError extends Error {
  constructor(readonly status: PatientImportStatus) {
    super(`batch in ${status}`);
  }
}

export interface UndoResult {
  undoneCreated: number;
  undoneFilled: number;
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

/** Tablas cuya fila de un paciente impide deshacer su alta (DX-107). */
const ACTIVITY_TABLES = [
  'appointments',
  'appointment_waitlist',
  'treatment_plans',
  'payments',
  'payment_plans',
  'medical_history_versions',
  'clinical_entries',
  'tooth_records',
  'perio_exams',
  'prescriptions',
  'patient_documents',
  'patient_consents',
  'data_processing_consents',
  'patient_implants',
  'patient_coverages',
  'patient_responsible_parties',
  'collection_notes',
  'payment_promises',
] as const;

/**
 * Persistencia de la importación de pacientes (DX-107). Todo bajo
 * `runWithTenant` (RLS FORCE): el tenant sale del contexto, nunca del cliente.
 */
@Injectable()
export class PrismaPatientImportRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const id = this.tenantContext.getTenantId();
    if (!id) throw new Error('No tenant in context');
    return id;
  }

  /** Sede del lote (la de escritura del request) y su país. */
  async batchLocation(): Promise<{ id: string; country: string }> {
    return this.prisma.runWithTenant(async (tx) => {
      const id = await this.tenantContext.writeLocationId(tx);
      const location = await tx.location.findFirstOrThrow({
        where: { id, deletedAt: null },
        select: { id: true, country: true },
      });
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
               regexp_replace(upper("docNumber"), '[^0-9A-Z]', '', 'g') AS "docKey"
          FROM "patients"
         WHERE "tenantId" = ${tenantId}::uuid
           AND "deletedAt" IS NULL
           AND "docNumber" IS NOT NULL
           AND regexp_replace(upper("docNumber"), '[^0-9A-Z]', '', 'g') = ANY(${keys}::text[])`,
    );
  }

  /**
   * Guarda el dry-run: el lote VALIDATED y sus filas preparadas. Los lotes
   * VALIDATED anteriores del mismo usuario caducan (se subió otro fichero) y
   * se vacían sus datos.
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
   * VALIDATED → EXPIRED (con sus datos vaciados): los de un usuario al subir
   * otro fichero, o los anteriores a `before` en el barrido diario.
   */
  private async expireValidated(
    tx: Tx,
    where: { createdById?: string; before?: Date },
  ): Promise<number> {
    const stale = await tx.patientImportBatch.findMany({
      where: {
        status: 'VALIDATED',
        ...(where.createdById ? { createdById: where.createdById } : {}),
        ...(where.before ? { createdAt: { lt: where.before } } : {}),
      },
      select: { id: true },
    });
    if (stale.length === 0) return 0;
    const ids = stale.map((b) => b.id);
    await tx.patientImportRow.updateMany({
      where: { batchId: { in: ids } },
      data: { data: Prisma.DbNull },
    });
    await tx.patientImportBatch.updateMany({
      where: { id: { in: ids }, status: 'VALIDATED' },
      data: { status: 'EXPIRED' },
    });
    return ids.length;
  }

  /** Barrido diario: lotes sin confirmar de más de `before`, clínica a clínica. */
  async expireStale(tenantId: string, before: Date): Promise<number> {
    return this.prisma.runWithTenant(tenantId, (tx) =>
      this.expireValidated(tx, { before }),
    );
  }

  async tenantIds(): Promise<string[]> {
    const rows = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async findBatch(id: string): Promise<PatientImportBatch | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.patientImportBatch.findFirst({ where: { id } }),
    );
  }

  async listBatches(
    take: number,
    skip: number,
  ): Promise<{ items: PatientImportBatch[]; total: number }> {
    return this.prisma.runWithTenant(async (tx) => {
      const where = {
        status: { notIn: ['VALIDATED', 'EXPIRED'] as PatientImportStatus[] },
      };
      const [items, total] = await Promise.all([
        tx.patientImportBatch.findMany({
          where,
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
   * el trabajo en la MISMA transacción (outbox). `enqueue` recibe la tx.
   */
  async confirm(
    id: string,
    input: {
      mode: PatientImportDuplicateMode;
      confirmedById: string;
      validatedAfter: Date;
      enqueue: (tx: Tx) => Promise<void>;
    },
  ): Promise<PatientImportBatch | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await tx.$queryRaw<
        { status: PatientImportStatus; createdAt: Date }[]
      >`
        SELECT "status", "createdAt" FROM "patient_import_batches"
         WHERE "id" = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) return null;
      const { status, createdAt } = locked[0];
      if (status === 'VALIDATED' && createdAt < input.validatedAfter) {
        await this.expireValidated(tx, { before: input.validatedAfter });
        throw new BatchStateError('EXPIRED');
      }
      if (status !== 'VALIDATED') throw new BatchStateError(status);
      const batch = await tx.patientImportBatch.update({
        where: { id },
        data: {
          status: 'QUEUED',
          duplicateMode: input.mode,
          confirmedById: input.confirmedById,
          confirmedAt: new Date(),
        },
      });
      await input.enqueue(tx);
      return batch;
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
  async start(id: string): Promise<PatientImportBatch | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<{ status: PatientImportStatus }[]>`
        SELECT "status" FROM "patient_import_batches" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const status = rows[0]?.status;
      if (status !== 'QUEUED' && status !== 'RUNNING') return null;
      return tx.patientImportBatch.update({
        where: { id },
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
   * vuelve a salir. Si el bloque falla entero, se reintenta fila a fila y la
   * que siga fallando queda FAILED; si fallan todas, el error sube (corte de
   * BD: lo reintenta la cola).
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
    if (pending.length === 0) {
      return { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
    }
    try {
      return await this.prisma.runWithTenant((tx) =>
        this.applyRows(tx, batch, pending, channel),
      );
    } catch (chunkError) {
      const total: ChunkResult = {
        processed: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
      };
      for (const row of pending) {
        try {
          const one = await this.prisma.runWithTenant((tx) =>
            this.applyRows(tx, batch, [row], channel),
          );
          total.processed += one.processed;
          total.created += one.created;
          total.updated += one.updated;
          total.skipped += one.skipped;
        } catch {
          total.failed += 1;
        }
      }
      if (total.failed === pending.length) throw chunkError;
      if (total.failed > 0) {
        const failedIds = pending.map((r) => r.id);
        await this.prisma.runWithTenant(async (tx) => {
          const n = await tx.patientImportRow.updateMany({
            where: { id: { in: failedIds }, outcome: 'PENDING' },
            data: {
              outcome: 'FAILED',
              data: Prisma.DbNull,
              processedAt: new Date(),
            },
          });
          await this.bumpCounters(tx, batch.id, {
            processed: n.count,
            created: 0,
            updated: 0,
            skipped: 0,
            failed: n.count,
          });
        });
        total.processed += total.failed;
      }
      return total;
    }
  }

  private async applyRows(
    tx: Tx,
    batch: Pick<PatientImportBatch, 'id' | 'duplicateMode' | 'confirmedById'>,
    rows: { id: string; rowNumber: number; data: Prisma.JsonValue }[],
    channel: ContactChannel,
  ): Promise<ChunkResult> {
    const tenantId = this.tenantId();
    const items = rows
      .filter((r) => r.data !== null)
      .map((r) => ({ ...r, data: r.data as unknown as ImportPatientData }));
    const keys = [...new Set(items.map((r) => docKey(r.data.docNumber)))];
    // Los pacientes que YA existen, bloqueados: rellenar sus vacíos no
    // compite con una edición a la vez.
    const existing = keys.length
      ? await tx.$queryRaw<
          (FillablePatient & { id: string; docType: string; docKey: string })[]
        >`
          SELECT "id", "docType", "birthDate", "sex", "phone", "email", "address",
                 "occupation", "emergencyContactName", "emergencyContactPhone", "notes",
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
    const result: ChunkResult = {
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    };

    for (const item of items) {
      const match = byKey.get(docKey(item.data.docNumber));
      if (!match) {
        fresh.push(item);
        continue;
      }
      // Otro tipo con el mismo número (creado tras el dry-run): no se toca.
      if (
        match.docType !== item.data.docType ||
        batch.duplicateMode !== 'FILL_EMPTY'
      ) {
        outcomes.push({
          id: item.id,
          outcome: 'SKIPPED',
          patientId: match.docType === item.data.docType ? match.id : null,
          filled: null,
        });
        result.skipped += 1;
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
        result.skipped += 1;
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
      result.updated += 1;
    }

    if (fresh.length > 0) {
      const now = new Date();
      // ON CONFLICT DO NOTHING (patients_tenant_doc_key): si alguien da de
      // alta el mismo documento a la vez, gana su alta y la fila se salta.
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
          result.created += 1;
        } else {
          outcomes.push({
            id: r.id,
            outcome: 'SKIPPED',
            patientId: null,
            filled: null,
          });
          result.skipped += 1;
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
      result.skipped += 1;
    }

    await tx.$executeRaw`
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
       WHERE r."id" = v.id AND r."outcome" = 'PENDING'`;
    result.processed = outcomes.length;
    await this.bumpCounters(tx, batch.id, result);
    return result;
  }

  private async bumpCounters(
    tx: Tx,
    batchId: string,
    r: ChunkResult,
  ): Promise<void> {
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
   * «Deshacer lote»: retira en blando los pacientes que CREÓ el lote y
   * revierte lo que rellenó en los existentes (solo los campos que siguen con
   * el valor del lote). Se niega si alguno de los creados ya tiene citas,
   * historia, planes, pagos, documentos, consentimientos… Todo en una
   * transacción que bloquea solo las filas del lote.
   */
  async undo(id: string, undoneById: string): Promise<UndoResult> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await tx.$queryRaw<{ status: PatientImportStatus }[]>`
        SELECT "status" FROM "patient_import_batches" WHERE "id" = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new BatchStateError('EXPIRED');
      const { status } = locked[0];
      if (status !== 'COMPLETED' && status !== 'FAILED')
        throw new BatchStateError(status);

      const created = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "patients"
         WHERE "tenantId" = ${tenantId}::uuid AND "import_batch_id" = ${id}::uuid
           AND "deletedAt" IS NULL
         ORDER BY "id"
         FOR UPDATE`;
      const ids = created.map((p) => p.id);
      if (ids.length > 0) {
        const checks = ACTIVITY_TABLES.map(
          (t) =>
            Prisma.sql`SELECT "patientId" AS id FROM ${Prisma.raw(`"${t}"`)}
                        WHERE "tenantId" = ${tenantId}::uuid AND "patientId" = ANY(${ids}::uuid[])`,
        );
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(DISTINCT id)::int AS n FROM (${Prisma.join(checks, ' UNION ALL ')}) a`;
        const [{ r }] = await tx.$queryRaw<{ r: number }[]>`
          SELECT count(DISTINCT "responsiblePatientId")::int AS r FROM "patient_responsible_parties"
           WHERE "tenantId" = ${tenantId}::uuid AND "responsiblePatientId" = ANY(${ids}::uuid[])`;
        if (n + r > 0) throw new UndoBlockedError(n + r);
      }
      for (let i = 0; i < ids.length; i += UNDO_CHUNK) {
        await tx.$executeRaw`
          UPDATE "patients" SET "deletedAt" = now(), "updatedAt" = now()
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
      return { undoneCreated: ids.length, undoneFilled };
    }, LONG_TX);
  }
}
